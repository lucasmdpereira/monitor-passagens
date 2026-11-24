import { fetchText, Offer, PriceProvider, ProviderError, SearchQuery } from './types';

/**
 * Google Flights uses an undocumented positional RPC response.
 * A round-trip search returns outbound candidates and a preliminary pair price;
 * the return itinerary is not selected here and must never be marked complete.
 */

const ENDPOINT =
  'https://www.google.com/_/FlightsFrontendUi/data/travel.frontend.flights.FlightsFrontendService/GetShoppingResults';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

const TRIP = { roundTrip: 1, oneWay: 2 };
const ECONOMY = 1;
const ORDEM_MELHORES = 1;

/** Qualquer numero de paradas; o Google usa 1 = direto, 2 = ate 1, 3 = ate 2. */
function stopsFilter(maxStops?: number): number {
  if (maxStops === undefined) return 0;
  return Math.min(maxStops, 2) + 1;
}

function segment(from: string, to: string, date: string, maxStops?: number): unknown[] {
  return [
    [[[from.toUpperCase(), 0]]],
    [[[to.toUpperCase(), 0]]],
    null,
    stopsFilter(maxStops),
    null,
    null,
    date,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    3,
  ];
}

/** O corpo e um JSON posicional, serializado duas vezes, dentro de um form. */
function requestBody(query: SearchQuery): string {
  const segments = [segment(query.origin, query.destination, query.departDate, query.maxStops)];
  if (query.returnDate) {
    segments.push(segment(query.destination, query.origin, query.returnDate, query.maxStops));
  }

  const filters = [
    [],
    [
      null,
      null,
      query.returnDate ? TRIP.roundTrip : TRIP.oneWay,
      null,
      [],
      ECONOMY,
      [query.adults, 0, 0, 0],
      null,
      null,
      null,
      null,
      null,
      null,
      segments,
      null,
      null,
      null,
      1,
    ],
    ORDEM_MELHORES,
    0,
    0,
    2,
  ];

  return `f.req=${encodeURIComponent(JSON.stringify([null, JSON.stringify(filters)]))}`;
}

function responseError(code: string, message: string, rpcCode?: number): ProviderError {
  return Object.assign(new ProviderError(`${code}: ${message}`, 'google'), {
    code,
    ...(rpcCode === undefined ? {} : { rpcCode }),
  });
}

/** Decode the observed response envelope without exposing opaque RPC payloads. */
function parseResponse(text: string): unknown[] {
  let outer: unknown;
  try {
    outer = JSON.parse(text.replace(/^\)\]\}'/, ''));
  } catch {
    throw responseError('GOOGLE_RESPONSE_UNREADABLE', 'The response is not a readable JSON envelope.');
  }
  if (!Array.isArray(outer) || !Array.isArray(outer[0]) || outer[0][0] !== 'wrb.fr') {
    throw responseError('GOOGLE_RESPONSE_SCHEMA_CHANGED', 'The expected RPC envelope is absent.');
  }
  for (const frame of outer) {
    if (!Array.isArray(frame) || frame[0] !== 'wrb.fr' || !Array.isArray(frame[5])) continue;
    const rpcCode = frame[5][0];
    if (Number.isInteger(rpcCode) && rpcCode !== 0) {
      throw responseError('GOOGLE_RPC_ERROR', `Google Flights returned ErrorResponse (${rpcCode}).`, rpcCode);
    }
    throw responseError('GOOGLE_RESPONSE_SCHEMA_CHANGED', 'An unrecognized RPC error envelope was returned.');
  }
  const inner = outer[0][2];
  if (typeof inner !== 'string') {
    throw responseError('GOOGLE_RESPONSE_SCHEMA_CHANGED', 'The expected serialized result is absent.');
  }
  let data: unknown;
  try { data = JSON.parse(inner); } catch {
    throw responseError('GOOGLE_RESPONSE_UNREADABLE', 'The serialized result is not readable JSON.');
  }
  if (!Array.isArray(data)) {
    throw responseError('GOOGLE_RESPONSE_SCHEMA_CHANGED', 'The result is not the expected positional array.');
  }
  const flights: unknown[] = [];
  let recognizedGroups = 0;
  // Both groups were observed; one may be absent, but absent groups are not proof of zero results.
  for (const index of [2, 3]) {
    const group = data[index];
    if (group === null || group === undefined) continue;
    if (!Array.isArray(group) || !Array.isArray(group[0])) {
      throw responseError('GOOGLE_RESPONSE_SCHEMA_CHANGED', 'A flight-results group has an unexpected shape.');
    }
    recognizedGroups += 1;
    flights.push(...group[0]);
  }
  if (recognizedGroups === 0) {
    throw responseError('GOOGLE_RESPONSE_SCHEMA_CHANGED', 'No recognized flight-results group was returned.');
  }
  return flights;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Zero hour/minute components may be omitted inside an observed time array. */
function localTime(date: unknown, time: unknown): string {
  if (!Array.isArray(date) || date.length !== 3 || !date.every(Number.isInteger)
      || date[0] < 1000 || date[0] > 9999 || !Array.isArray(time) || time.length > 2) {
    throw responseError('GOOGLE_INVALID_OFFER', 'A segment date or time is absent or malformed.');
  }
  const [hours = 0, minutes = 0] = time.map(value => value ?? 0);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    throw responseError('GOOGLE_INVALID_OFFER', 'A segment time is invalid.');
  }
  const day = `${date[0]}-${pad(date[1])}-${pad(date[2])}`;
  const timestamp = Date.parse(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== day) {
    throw responseError('GOOGLE_INVALID_OFFER', 'A segment calendar date is invalid.');
  }
  return `${day}T${pad(hours)}:${pad(minutes)}:00`;
}

interface ObservedSegment {
  from: string;
  to: string;
  departure: string;
  arrival: string;
  carrier: string | null;
}

function observedSegment(leg: any): ObservedSegment {
  if (!Array.isArray(leg) || typeof leg[3] !== 'string' || !/^[A-Z]{3}$/.test(leg[3])
      || typeof leg[6] !== 'string' || !/^[A-Z]{3}$/.test(leg[6])) {
    throw responseError('GOOGLE_INVALID_OFFER', 'A segment airport is absent or malformed.');
  }
  return {
    from: leg[3], to: leg[6],
    departure: localTime(leg[20], leg[8]), arrival: localTime(leg[21], leg[10]),
    carrier: typeof leg[22]?.[0] === 'string' ? leg[22][0] : null,
  };
}

function toOffer(raw: any, query: SearchQuery): Offer {
  const amount = raw?.[1]?.[0];
  if (!Array.isArray(amount) || amount.length !== 2 || amount[0] !== null) {
    throw responseError('GOOGLE_RESPONSE_SCHEMA_CHANGED', 'The price field has an unexpected shape.');
  }
  const price = amount[1];
  if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) {
    throw responseError('GOOGLE_INVALID_OFFER', 'The price is not a positive finite number.');
  }
  const legs = raw?.[0]?.[2];
  if (!Array.isArray(legs) || legs.length === 0) {
    throw responseError('GOOGLE_INVALID_OFFER', 'The outbound itinerary has no observed segments.');
  }
  const segments = legs.map(observedSegment);
  const airlines = raw?.[0]?.[1];
  if (airlines != null && (!Array.isArray(airlines) || !airlines.every(name => typeof name === 'string'))) {
    throw responseError('GOOGLE_RESPONSE_SCHEMA_CHANGED', 'The airline field has an unexpected shape.');
  }
  return {
    price,
    currency: 'BRL',
    airline: airlines?.length ? airlines.join(' + ') : (typeof legs[0]?.[22]?.[3] === 'string' ? legs[0][22][3] : null),
    cabin: 'ECONOMY',
    checkedBags: null,
    stopsOut: segments.length - 1,
    stopsRet: null,
    departAt: segments[0].departure,
    returnAt: null,
    // The previous text-search URL did not preserve the requested adult count.
    link: null,
    raw: {
      flights: legs.map(leg => `${leg?.[22]?.[0] ?? ''}${leg?.[22]?.[1] ?? ''} ${leg[3]}->${leg[6]}`),
      segments,
      query_adults: query.adults,
      itinerary_complete: !query.returnDate,
      price_scope: query.returnDate ? 'round_trip_preview' : 'one_way_total',
    },
  };
}

export const google: PriceProvider = {
  name: 'google',

  isConfigured() {
    return true;
  },

  async search(query: SearchQuery): Promise<Offer[]> {
    let text: string;
    try {
      text = await fetchText(`${ENDPOINT}?hl=pt-BR&gl=BR&curr=BRL`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
          'User-Agent': UA,
          'Accept-Language': 'pt-BR,pt;q=0.9',
          Origin: 'https://www.google.com',
          Referer: 'https://www.google.com/travel/flights',
        },
        body: requestBody(query),
        timeoutMs: 30_000,
      });
    } catch (err) {
      throw new ProviderError((err as Error).message, 'google');
    }

    const flights = parseResponse(text);
    return flights.map(flight => toOffer(flight, query));
  },
};
