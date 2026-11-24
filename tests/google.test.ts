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
  return [[null, ['Azul'], [leg]], [[null, price]]];
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

test('Google preserves two-adult RT request and exposes only the observed outbound itinerary', async context => {
  let requestSeen = false;
  mockResponse(context, resultEnvelope([observedOffer()]), (url, init) => {
    requestSeen = true;
    assert.equal(new URL(url).searchParams.get('curr'), 'BRL');
    assert.equal(init?.method, 'POST');
    const outer = JSON.parse(new URLSearchParams(String(init?.body)).get('f.req')!);
    const filters = JSON.parse(outer[1]);
    assert.equal(filters[1][2], 1);
    assert.deepEqual(filters[1][6], [2, 0, 0, 0]);
    assert.equal(filters[1][13].length, 2);
    assert.equal(filters[1][13][0][6], '2027-03-10');
    assert.equal(filters[1][13][1][6], '2027-03-17');
  });
  const [offer] = await google.search(query);
  assert.equal(requestSeen, true);
  assert.equal(offer.price, 3119);
  assert.equal(offer.link, null);
  assert.equal(offer.returnAt, null);
  assert.equal(offer.stopsRet, null);
  assert.deepEqual(offer.raw, {
    flights: ['AD4890 CNF->REC'],
    segments: [{ from: 'CNF', to: 'REC', departure: '2027-03-10T12:55:00', arrival: '2027-03-10T15:20:00', carrier: 'AD' }],
    query_adults: 2,
    itinerary_complete: false,
    price_scope: 'round_trip_preview',
  });
});

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
  const [offer] = await google.search(query);
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
