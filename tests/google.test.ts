import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { google } from '../src/providers/google';
import { ProviderError, type SearchQuery } from '../src/providers/types';

const query: SearchQuery = {
  origin: 'CNF', destination: 'REC', departDate: '2027-03-10', returnDate: '2027-03-17', adults: 2,
};

// Minimal public flight fields from response-003.txt / response-012.txt captured
// on 2026-11-24. Opaque session, booking and RPC values are deliberately omitted.
function observedOffer(inbound = false, price: unknown = inbound ? 1648 : 3119): unknown[] {
  const leg: unknown[] = Array(23).fill(null);
  leg[3] = inbound ? 'REC' : 'CNF';
  leg[6] = inbound ? 'CNF' : 'REC';
  leg[8] = inbound ? [2, 40] : [12, 55];
  leg[10] = inbound ? [5, 15] : [15, 20];
  leg[20] = inbound ? [2027, 3, 17] : [2027, 3, 10];
  leg[21] = inbound ? [2027, 3, 17] : [2027, 3, 10];
  leg[22] = ['AD', inbound ? '4605' : '4890', null, 'Azul'];
  return [[null, ['Azul'], [leg]], [[null, price], 'sanitized-summary-token']];
}

function resultEnvelope(offers: unknown[], secondGroup: unknown = [[], null, null, null, null]): string {
  const data = [null, null, [offers, null, null, null, null], secondGroup];
  return ")]}'\n\n" + JSON.stringify([['wrb.fr', null, JSON.stringify(data)], ['di', 42]]);
}

function mockResponse(context: TestContext, text: string, inspect?: (url: string, init?: RequestInit) => void): void {
  context.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    inspect?.(String(url), init);
    return new Response(text, { status: 200, headers: { 'content-type': 'application/json' } });
  });
}

function errorCode(code: string, rpcCode?: number) {
  return (error: unknown) => {
    assert.ok(error instanceof ProviderError);
    assert.equal((error as ProviderError & { code: string }).code, code);
    if (rpcCode !== undefined) assert.equal((error as ProviderError & { rpcCode: number }).rpcCode, rpcCode);
    return true;
  };
}

function mockSequence(context: TestContext, responses: (string | Response | Error)[]) {
  const requests: any[] = [];
  context.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    const filters = JSON.parse(JSON.parse(new URLSearchParams(String(init?.body)).get('f.req')!)[1]);
    requests.push({ url: String(url), init, filters });
    const next = responses[requests.length - 1];
    if (next === undefined) throw new Error('Unexpected extra mocked request');
    if (next instanceof Error) throw next;
    return next instanceof Response ? next : new Response(next, { status: 200 });
  });
  return requests;
}

for (const adults of [2, 1]) {
  test(`Google completes a ${adults}-adult RT and uses the changed return-shopping total directly`, async context => {
    const requests = mockSequence(context, [
      resultEnvelope([observedOffer(false, 3119)]), resultEnvelope([observedOffer(true, 3205)]),
    ]);
    const [offer] = await google.search({ ...query, adults });
    assert.equal(requests.length, 2);
    for (const { url, init, filters } of requests) {
      assert.equal(new URL(url).searchParams.get('curr'), 'BRL');
      assert.equal(init.method, 'POST');
      assert.equal(filters[1][2], 1);
      assert.deepEqual(filters[1][6], [adults, 0, 0, 0]);
      assert.equal(filters[1][13].length, 2);
      assert.equal(filters[1][13][0][6], '2027-03-10');
      assert.equal(filters[1][13][1][6], '2027-03-17');
    }
    assert.equal(requests[0].filters[1][13][0][8], null);
    assert.deepEqual(requests[1].filters[1][13][0][8], [['CNF', '2027-03-10', 'REC', null, 'AD', '4890']]);
    assert.deepEqual(requests[1].filters[0], [null, 'sanitized-summary-token']);
    assert.deepEqual(requests[1].filters.slice(2), [0, 0, 0, 1]);
    assert.equal(offer.price, 3205);
    assert.equal(offer.link, null);
    assert.equal(offer.returnAt, '2027-03-17T02:40:00');
    assert.equal(offer.stopsRet, 0);
    assert.equal(offer.warnings, undefined);
    assert.deepEqual(offer.raw, {
      flights: ['AD4890 CNF->REC', 'AD4605 REC->CNF'],
      segments: [{ from: 'CNF', to: 'REC', departure: '2027-03-10T12:55:00', arrival: '2027-03-10T15:20:00', carrier: 'AD' }],
      inbound_segments: [{ from: 'REC', to: 'CNF', departure: '2027-03-17T02:40:00', arrival: '2027-03-17T05:15:00', carrier: 'AD' }],
      query_adults: adults, itinerary_complete: true, price_scope: 'round_trip_total',
    });
  });
}

test('Google one-way return direction retains its date, route and one-way price scope', async context => {
  const oneWay = { ...query, origin: 'REC', destination: 'CNF', departDate: '2027-03-17', returnDate: null };
  mockResponse(context, resultEnvelope([observedOffer(true)], null), (_url, init) => {
    const filters = JSON.parse(JSON.parse(new URLSearchParams(String(init?.body)).get('f.req')!)[1]);
    assert.equal(filters[1][2], 2);
    assert.deepEqual(filters[1][6], [2, 0, 0, 0]);
    assert.equal(filters[1][13].length, 1);
  });
  const [offer] = await google.search(oneWay);
  assert.equal(offer.price, 1648);
  assert.equal(offer.departAt, '2027-03-17T02:40:00');
  assert.deepEqual((offer.raw as { segments: unknown }).segments, [
    { from: 'REC', to: 'CNF', departure: '2027-03-17T02:40:00', arrival: '2027-03-17T05:15:00', carrier: 'AD' },
  ]);
  assert.equal((offer.raw as { itinerary_complete: boolean }).itinerary_complete, true);
  assert.equal((offer.raw as { price_scope: string }).price_scope, 'one_way_total');
});

test('Google expands a valid duplicate after a cheaper outbound with a missing summary token', async context => {
  const missingToken = observedOffer(false, 3000) as any[];
  missingToken[1][1] = null;
  const requests = mockSequence(context, [
    resultEnvelope([observedOffer(false, 3100), missingToken]),
    resultEnvelope([observedOffer(true, 3200)]),
  ]);
  const offers = await google.search(query);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].filters[0], [null, 'sanitized-summary-token']);
  assert.equal(offers.length, 2);
  assert.equal(offers[0].price, 3000);
  assert.equal((offers[0].raw as any).itinerary_complete, false);
  assert.match(offers[0].warnings!.join(' '), /summary token is missing/);
  assert.equal(offers[1].price, 3200);
  assert.equal((offers[1].raw as any).price_scope, 'round_trip_total');
  assert.equal((offers[1].raw as any).itinerary_complete, true);
  assert.equal(offers[1].warnings, undefined);
});

test('Google HTTP 200 ErrorResponse 13 is a provider error, not an empty successful result', async context => {
  // Sanitized shape of response-011.txt; the nested diagnostic/session payload is omitted.
  const body = ")]}'\n\n" + JSON.stringify([
    ['wrb.fr', null, null, null, null, [13, null, [['type.googleapis.com/travel.frontend.flights.ErrorResponse', []]]]],
    ['di', 42],
  ]);
  mockResponse(context, body);
  await assert.rejects(google.search({ ...query, returnDate: null }), errorCode('GOOGLE_RPC_ERROR', 13));
});

test('Google distinguishes malformed JSON from an unexpected result schema', async context => {
  for (const [body, code] of [
    ['not JSON', 'GOOGLE_RESPONSE_UNREADABLE'],
    [JSON.stringify([['wrb.fr', null, '{bad json']]), 'GOOGLE_RESPONSE_UNREADABLE'],
    [JSON.stringify([['wrb.fr', null, '[]']]), 'GOOGLE_RESPONSE_SCHEMA_CHANGED'],
    [JSON.stringify([['wrb.fr', null, '{}']]), 'GOOGLE_RESPONSE_SCHEMA_CHANGED'],
    [JSON.stringify([['unknown', null, '[]']]), 'GOOGLE_RESPONSE_SCHEMA_CHANGED'],
    [resultEnvelope([observedOffer()], { changed: true }), 'GOOGLE_RESPONSE_SCHEMA_CHANGED'],
  ]) {
    mockResponse(context, body);
    await assert.rejects(google.search(query), errorCode(code));
    context.mock.restoreAll();
  }
});

test('Google accepts an explicitly empty recognized group instead of fabricating an offer', async context => {
  mockResponse(context, resultEnvelope([]));
  assert.deepEqual(await google.search(query), []);
});

test('Google rejects invalid prices instead of silently dropping malformed offers', async context => {
  for (const price of [0, -1, null, '3119']) {
    mockResponse(context, resultEnvelope([observedOffer(false, price)]));
    await assert.rejects(google.search(query), errorCode('GOOGLE_INVALID_OFFER'));
    context.mock.restoreAll();
  }
  // JSON permits an exponent that overflows the JavaScript finite number range.
  mockResponse(context, resultEnvelope([observedOffer(false, 999999)]).replace('999999', '1e400'));
  await assert.rejects(google.search(query), errorCode('GOOGLE_INVALID_OFFER'));
});

test('Google rejects shifted price structure and missing itinerary evidence', async context => {
  const malformedPrice = observedOffer();
  malformedPrice[1] = [[null, 3119, 1]];
  mockResponse(context, resultEnvelope([malformedPrice]));
  await assert.rejects(google.search(query), errorCode('GOOGLE_RESPONSE_SCHEMA_CHANGED'));
  context.mock.restoreAll();
  const missingLeg = observedOffer();
  (missingLeg[0] as unknown[])[2] = [];
  mockResponse(context, resultEnvelope([missingLeg]));
  await assert.rejects(google.search(query), errorCode('GOOGLE_INVALID_OFFER'));
});

test('Google parses omitted zero time components but rejects invalid or missing calendar evidence', async context => {
  const valid = observedOffer() as any[];
  valid[0][2][0][8] = [null, 40];
  valid[0][2][0][10] = [5];
  mockResponse(context, resultEnvelope([valid]));
  const [offer] = await google.search({ ...query, returnDate: null });
  assert.equal(offer.departAt, '2027-03-10T00:40:00');
  assert.equal((offer.raw as any).segments[0].arrival, '2027-03-10T05:00:00');
  context.mock.restoreAll();
  for (const [field, invalid] of [[20, [2027, 2, 30]], [8, null], [10, [25]], [3, null]] as const) {
    const bad = observedOffer() as any[];
    bad[0][2][0][field] = invalid;
    mockResponse(context, resultEnvelope([bad]));
    await assert.rejects(google.search(query), errorCode('GOOGLE_INVALID_OFFER'));
    context.mock.restoreAll();
  }
});

test('Google fixes every outbound connection with its own departure date', async context => {
  const row = observedOffer() as any[];
  const first = row[0][2][0];
  first[6] = 'BSB'; first[8] = [23, 10]; first[10] = [null, 40]; first[21] = [2027, 3, 11];
  const next = structuredClone(first);
  next[3] = 'BSB'; next[6] = 'REC'; next[8] = [1, 30]; next[10] = [4];
  next[20] = [2027, 3, 11]; next[22][1] = '4891';
  row[0][2].push(next);
  const requests = mockSequence(context, [resultEnvelope([row]), resultEnvelope([observedOffer(true, 3500)])]);
  const [offer] = await google.search(query);
  assert.deepEqual(requests[1].filters[1][13][0][8], [
    ['CNF', '2027-03-10', 'BSB', null, 'AD', '4890'],
    ['BSB', '2027-03-11', 'REC', null, 'AD', '4891'],
  ]);
  assert.equal(offer.stopsOut, 1);
  assert.equal((offer.raw as any).itinerary_complete, true);
});

test('Google does not guess absent or malformed outbound flight identifiers or summary tokens', async context => {
  for (const invalid of [null, 4890, 'AD4890', '4890?', '']) {
    const row = observedOffer() as any[]; row[0][2][0][22][1] = invalid;
    const requests = mockSequence(context, [resultEnvelope([row])]);
    const [offer] = await google.search(query);
    assert.equal(requests.length, 1);
    assert.equal((offer.raw as any).itinerary_complete, false);
    assert.match(offer.warnings![0], /GOOGLE_OUTBOUND_SELECTION_UNAVAILABLE/);
    context.mock.restoreAll();
  }
  const noToken = observedOffer() as any[]; noToken[1][1] = null;
  const requests = mockSequence(context, [resultEnvelope([noToken])]);
  const [offer] = await google.search(query);
  assert.equal(requests.length, 1);
  assert.match(offer.warnings![0], /summary token is missing/);
});

test('Google retains valid return options and warns about rejected route, date and flight identifiers', async context => {
  const wrongRoute = observedOffer(true) as any[]; wrongRoute[0][2][0][6] = 'GRU';
  const wrongDate = observedOffer(true) as any[]; wrongDate[0][2][0][20] = [2027, 3, 18];
  const noFlight = observedOffer(true) as any[]; noFlight[0][2][0][22][1] = null;
  mockSequence(context, [resultEnvelope([observedOffer()]), resultEnvelope([wrongRoute, wrongDate, noFlight, observedOffer(true, 3200)])]);
  const offers = await google.search(query);
  assert.equal(offers.length, 1);
  assert.equal(offers[0].price, 3200);
  assert.equal((offers[0].raw as any).itinerary_complete, true);
  assert.match(offers[0].warnings![0], /3 return options were discarded/);
});

test('Google rejects reversed connection times and a return before outbound arrival', async context => {
  const reversedConnection = observedOffer(true) as any[];
  const first = reversedConnection[0][2][0]; first[6] = 'BSB';
  const second = structuredClone(first); second[3] = 'BSB'; second[6] = 'CNF'; second[8] = [4]; second[10] = [6];
  reversedConnection[0][2].push(second);
  mockSequence(context, [resultEnvelope([observedOffer()]), resultEnvelope([reversedConnection])]);
  const [connectionPreview] = await google.search(query);
  assert.equal((connectionPreview.raw as any).itinerary_complete, false);
  assert.match(connectionPreview.warnings![0], /GOOGLE_INVALID_RETURN_OPTIONS/);
  context.mock.restoreAll();
  const tooEarly = observedOffer(true) as any[];
  tooEarly[0][2][0][20] = [2027, 3, 10]; tooEarly[0][2][0][21] = [2027, 3, 10];
  mockSequence(context, [resultEnvelope([observedOffer()]), resultEnvelope([tooEarly])]);
  const [chronologyPreview] = await google.search({ ...query, returnDate: '2027-03-10' });
  assert.equal((chronologyPreview.raw as any).itinerary_complete, false);
  assert.match(chronologyPreview.warnings![0], /GOOGLE_INVALID_RETURN_OPTIONS/);
});

function distinctOutbound(number: number, price = 3000): any[] {
  const row = observedOffer(false, price) as any[];
  row[0][2][0][22][1] = String(number);
  return row;
}

test('Google preserves successful pairs then stops further expansions after HTTP 429', async context => {
  const requests = mockSequence(context, [
    resultEnvelope([distinctOutbound(4890, 3000), distinctOutbound(4891, 3100), distinctOutbound(4892, 3200)]),
    resultEnvelope([observedOffer(true, 3300)]),
    new Response('secret token=do-not-copy', { status: 429 }),
  ]);
  const offers = await google.search(query);
  assert.equal(requests.length, 3);
  assert.equal(offers.length, 3);
  assert.equal((offers[0].raw as any).itinerary_complete, true);
  for (const preview of offers.slice(1)) {
    assert.equal((preview.raw as any).itinerary_complete, false);
    assert.match(preview.warnings![0], /HTTP 429/);
    assert.doesNotMatch(preview.warnings![0], /secret|token=/);
  }
});

for (const [name, response, code] of [
  ['transport', new TypeError('network failed: token=private'), 'GOOGLE_TRANSPORT_ERROR'],
  ['RPC', JSON.stringify([['wrb.fr', null, null, null, null, [13, null, []]]]), 'GOOGLE_RPC_ERROR'],
  ['schema', JSON.stringify([['wrb.fr', null, '{}']]), 'GOOGLE_RESPONSE_SCHEMA_CHANGED'],
  ['HTTP 403', new Response('private details', { status: 403 }), 'HTTP 403'],
] as const) {
  test(`Google keeps previews and stops subsequent expansions on ${name} failure`, async context => {
    const requests = mockSequence(context, [resultEnvelope([distinctOutbound(4890), distinctOutbound(4891)]), response]);
    const offers = await google.search(query);
    assert.equal(requests.length, 2);
    assert.equal(offers.length, 2);
    for (const offer of offers) {
      assert.equal((offer.raw as any).itinerary_complete, false);
      assert.ok(offer.warnings![0].includes(code));
      assert.doesNotMatch(offer.warnings![0], /private|token=/);
    }
  });
}

test('Google distinguishes initial HTTP 403/429 for the source-level stop policy', async context => {
  for (const status of [403, 429]) {
    mockSequence(context, [new Response('private details', { status })]);
    await assert.rejects(google.search(query), errorCode(`HTTP_${status}`));
    context.mock.restoreAll();
  }
});

test('Google continues after explicit empty return options and preserves their preview', async context => {
  const requests = mockSequence(context, [
    resultEnvelope([distinctOutbound(4890), distinctOutbound(4891)]), resultEnvelope([]), resultEnvelope([observedOffer(true, 3200)]),
  ]);
  const offers = await google.search(query);
  assert.equal(requests.length, 3);
  assert.equal((offers[0].raw as any).itinerary_complete, false);
  assert.match(offers[0].warnings![0], /GOOGLE_RETURN_OPTIONS_UNAVAILABLE/);
  assert.equal((offers[1].raw as any).itinerary_complete, true);
});

test('Google retains valid rows but stops subsequent queries after a return row schema change', async context => {
  const bad = observedOffer(true) as any[]; bad[1][0].push(1);
  const requests = mockSequence(context, [
    resultEnvelope([distinctOutbound(4890), distinctOutbound(4891)]), resultEnvelope([bad, observedOffer(true, 3200)]),
  ]);
  const offers = await google.search(query);
  assert.equal(requests.length, 2);
  assert.equal((offers[0].raw as any).itinerary_complete, true);
  assert.equal((offers[1].raw as any).itinerary_complete, false);
  assert.ok(offers[0].warnings?.some(w => w.includes('GOOGLE_RESPONSE_SCHEMA_CHANGED')));
});

test('Google expands at most 20 distinct outbound flights in preview-price order and exposes capped coverage', async context => {
  const initial = Array.from({ length: 22 }, (_, index) => distinctOutbound(5000 + index, 4000 - index));
  initial.push(distinctOutbound(5005, 9000), distinctOutbound(5021, 9999));
  const requests = mockSequence(context, [
    resultEnvelope(initial), ...Array.from({ length: 20 }, () => resultEnvelope([observedOffer(true, 4200)])),
  ]);
  const offers = await google.search(query);
  assert.equal(requests.length, 21);
  assert.equal(requests[1].filters[1][13][0][8][0][5], '5021');
  assert.equal(new Set(requests.slice(1).map(r => r.filters[1][13][0][8][0][5])).size, 20);
  assert.equal(offers.length, 22);
  assert.equal(offers.filter(o => (o.raw as any).itinerary_complete).length, 20);
  const previews = offers.filter(o => !(o.raw as any).itinerary_complete);
  assert.equal(previews.length, 2);
  assert.ok(previews.every(o => o.warnings?.some(w => w.includes('GOOGLE_RETURN_SEARCH_CAP'))));
});
