import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { normalizeRequest, planSearch, DEFAULT_ORIGINS } from '../src/request';
import { normalizeQuote, compareQuotes } from '../src/quotes';
import { searchFlights } from '../src/search';

const fixtures = JSON.parse(readFileSync(new URL('./fixtures/captured-offers.json', import.meta.url), 'utf8'));
const input = { origins: ['CNF'], destinations: ['REC'], departure_date: '2027-03-10', return_date: '2027-03-17' };
const future = { ...input, departure_date: '2099-03-10', return_date: '2099-03-17' };
const at = '2026-11-24T12:00:00Z';

test('defaults to two adults and BH/Rio/SP origins, and plans all destinations in resumable batches', () => {
  const plan = planSearch({ departure_date: future.departure_date, return_date: future.return_date });
  assert.deepEqual(plan.request.origins, DEFAULT_ORIGINS);
  assert.equal(plan.request.passengers.adults, 2);
  assert.equal(plan.routes.length, 1);
  assert.ok(plan.total_routes > 100);
  assert.equal(plan.next_cursor, 1);
  assert.equal(plan.complete, false);
});

test('rejects invalid dates, international airports, fractional passengers and unsupported fields', () => {
  for (const patch of [{ departure_date: '2099-02-30' }, { return_date: '2099-03-01' }, { destinations: ['MIA'] },
    { passengers: 1.5 }, { passengers: { adults: 2, children: 1 } }, { currency: 'USD' }, { max_routes: 0 }, { origins: [] }, { cursor: -1 }]) {
    assert.throws(() => normalizeRequest({ ...future, ...patch }));
  }
});

test('normalizes and deduplicates airport lists; cursor preserves the next route', () => {
  const plan = planSearch({ ...future, origins: ['cnf', 'CNF', 'GRU'], destinations: ['REC', 'CNF'], max_routes: 2 });
  assert.equal(plan.total_routes, 3);
  const second = planSearch({ ...future, origins: ['cnf', 'CNF', 'GRU'], destinations: ['REC', 'CNF'], cursor: plan.next_cursor });
  assert.deepEqual(second.routes, [{ origin: 'GRU', destination: 'CNF' }]);
  assert.equal(second.next_cursor, null);
  assert.throws(() => planSearch({ ...future, cursor: 1 }));
});

test('MaxMilhas captured price reconciles two adults, both dates and PIX without double multiplication', () => {
  const { offer, query } = fixtures.maxmilhas['round-trip'];
  const result = normalizeQuote('maxmilhas', offer, query, at);
  assert.equal(result.price.amount_minor, 266538);
  assert.equal(result.price.adults, 2);
  assert.equal(result.conditions.payment, 'PIX');
  assert.equal(result.conditions.taxes_included, true);
  assert.equal(result.itinerary.inbound[0].from, 'REC');
  assert.equal(result.itinerary.complete, true);
  assert.equal(result.booking_confirmed, false);
});

test('Kiwi validates passengers from booking link and retains all carriers from both directions', () => {
  const { offer, query } = fixtures.kiwi['round-trip'];
  const result = normalizeQuote('kiwi', offer, query, at);
  assert.deepEqual(new Set(result.airlines), new Set(['G3', 'AD', 'LA']));
  assert.throws(() => normalizeQuote('kiwi', { ...offer, link: offer.link.replace('2-0-0', '1-0-0') }, query, at));
});

test('MaxMilhas grouped alternatives retain a single total and select a valid bound by direction', () => {
  const { offer, query } = fixtures.maxmilhas['round-trip'];
  const grouped = structuredClone(offer);
  const [out, back] = grouped.raw.bounds;
  const invalid = structuredClone(out);
  invalid.segments[0].departure.locationCode = 'GRU';
  grouped.raw.bounds = [invalid, out, structuredClone(out), back, structuredClone(back)];
  const result = normalizeQuote('maxmilhas', grouped, query, at);
  assert.equal(result.price.amount_minor, 266538);
  assert.equal(result.itinerary.outbound[0].from, 'CNF');
  assert.equal(result.itinerary.inbound[0].from, 'REC');
  assert.equal(result.itinerary.inbound[0].departure.slice(0, 10), query.returnDate);
  assert.ok(result.warnings.some(w => w.includes('grouped fare')));
});

test('rejects mismatched routes, dates, missing returns, invalid amounts and foreign currency', () => {
  const { offer, query } = fixtures.maxmilhas['round-trip'];
  for (const change of [(o: any) => { o.price = NaN; }, (o: any) => { o.price = -5; }, (o: any) => { o.currency = 'USD'; },
    (o: any) => { o.raw.bounds[0].segments[0].departure.locationCode = 'GRU'; },
    (o: any) => { o.raw.bounds[1].segments[0].departure.dateTime = '2027-03-18T02:40:00Z'; },
    (o: any) => { o.raw.bounds.pop(); }, (o: any) => { o.raw.priceDetails.unitPrices[0].paxTotalAmount = 1; }]) {
    const value = structuredClone(offer); change(value);
    assert.throws(() => normalizeQuote('maxmilhas', value, query, at));
  }
});

test('rejects connections beyond requested limit and airport changes', () => {
  const { offer, query } = fixtures.kiwi['round-trip'];
  assert.throws(() => normalizeQuote('kiwi', offer, { ...query, maxStops: 0 }, at));
  const modified = structuredClone(offer);
  modified.raw.outbound.sectorSegments[1].segment.source.station.code = 'GRU';
  assert.throws(() => normalizeQuote('kiwi', modified, query, at));
});

test('rejects zero-rounded prices, normalized invalid times, and malformed arrivals', () => {
  const { offer, query } = fixtures.kiwi['round-trip'];
  for (const change of [(o: any) => { o.price = 0.001; },
    (o: any) => { o.raw.outbound.sectorSegments[0].segment.source.localTime = '2027-03-10T24:00:00'; },
    (o: any) => { o.raw.outbound.sectorSegments[0].segment.destination.localTime = 'not-a-time'; }]) {
    const changed = structuredClone(offer); change(changed);
    assert.throws(() => normalizeQuote('kiwi', changed, query, at));
  }
});

test('partial failure diagnostics cannot export HTTP bodies or tokens', () => {
  const { offer, query } = fixtures.maxmilhas['round-trip'];
  const result = normalizeQuote('maxmilhas', { ...offer, warnings: ['maxmilhas/gol: HTTP 403 Forbidden {token:SYNTHETIC_SECRET}'] }, query, at);
  assert.equal(result.warnings[0], 'maxmilhas/gol: HTTP 403');
  assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_SECRET/);
});

test('Google round-trip preview cannot become the cheapest comparable trip', () => {
  const { query } = fixtures.maxmilhas['round-trip'];
  const preview = normalizeQuote('google', { price: 10, currency: 'BRL', airline: 'Azul', cabin: 'ECONOMY',
    checkedBags: null, stopsOut: 0, stopsRet: null, departAt: '2027-03-10T12:55:00', returnAt: null, link: null,
    raw: { query_adults: 2, segments: [{ from: 'CNF', to: 'REC', departure: '2027-03-10T12:55:00', arrival: null, carrier: 'AD' }] } }, query, at);
  assert.equal(preview.comparison_eligible, false);
  assert.equal(compareQuotes([preview], [], []).round_trip, null);
});

test('comparison uses group totals in cents and labels conditions as unverified', () => {
  const quote = (kind: string) => { const f = fixtures.maxmilhas[kind]; return normalizeQuote('maxmilhas', f.offer, f.query, at); };
  const result = compareQuotes([quote('round-trip')], [quote('outbound')], [quote('inbound')]);
  assert.equal(result.round_trip?.total_minor, 266538);
  assert.equal(result.separate?.total_minor, 267538);
  assert.equal(result.round_trip_minus_separate_minor, -1000);
  assert.equal(result.lower_observed_price, 'round_trip');
  assert.equal(result.conditions_comparable, false);
  assert.equal(result.exhaustive, false);
});

test('orchestration preserves 2 adults, searches RT and both directions, and returns structured offers', async () => {
  const calls: any[] = [];
  const provider = { name: 'maxmilhas', isConfigured: () => true, search: async (query: any) => {
    calls.push(query);
    const mode = query.returnDate ? 'round-trip' : query.origin === 'CNF' ? 'outbound' : 'inbound';
    const offer = structuredClone(fixtures.maxmilhas[mode].offer);
    for (const bound of offer.raw.bounds) for (const segment of bound.segments) {
      segment.departure.dateTime = segment.departure.dateTime.replace('2027-', '2099-');
      segment.arrival.dateTime = segment.arrival.dateTime.replace('2027-', '2099-');
    }
    return [offer];
  } };
  const result = await searchFlights({ ...future, providers: ['maxmilhas'] }, { providers: { maxmilhas: provider } as any });
  assert.equal(calls.length, 3);
  assert.ok(calls.every(q => q.adults === 2));
  assert.deepEqual([calls[2].origin, calls[2].destination, calls[2].departDate], ['REC', 'CNF', future.return_date]);
  assert.equal(result.routes[0].comparison.round_trip?.total_minor, 266538);
  assert.equal(result.status, 'ok');
  assert.doesNotMatch(JSON.stringify(result), /offerToken|bookingOptions|paxTaxesBreakdown/);
});

test('access block is reported and subsequent calls to the same source are skipped', async () => {
  let calls = 0;
  const provider = { name: 'google', isConfigured: () => true, search: async () => { calls++; throw new Error('HTTP 403 body token=private'); } };
  const result = await searchFlights({ ...future, providers: ['google'] }, { providers: { google: provider } as any });
  assert.equal(calls, 1);
  assert.deepEqual(result.routes[0].queries.map(q => q.status), ['blocked', 'skipped', 'skipped']);
  assert.equal(result.status, 'error');
  assert.doesNotMatch(JSON.stringify(result), /private/);
});
