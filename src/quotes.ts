import { createHash } from 'node:crypto';
import { domesticAirport, type ProviderName } from './request';
import type { Offer, SearchQuery } from './providers/types';

export interface Segment {
  from: string;
  to: string;
  departure: string;
  arrival: string | null;
  carrier: string;
}
export interface Quote {
  id: string;
  source: ProviderName;
  retrieved_at: string;
  price: { amount_minor: number; currency: 'BRL'; scope: 'all_passengers'; adults: number };
  itinerary: { outbound: Segment[]; inbound: Segment[]; complete: boolean; time_basis: string };
  airlines: string[];
  conditions: { cabin: string; checked_bags: number | null; payment: string; taxes_included: boolean | null; transfer_protection: 'unknown' };
  comparison_eligible: boolean;
  booking_confirmed: false;
  link: string | null;
  warnings: string[];
}

const ALLOWED_CARRIERS = new Set(['AD', 'G3', 'LA', 'JJ']);
const minor = (amount: number) => Math.round(amount * 100);

export function safeDiagnostic(message: string): string {
  const http = /HTTP\s+(\d{3})/.exec(message);
  if (http) return `${/^maxmilhas\/[a-z]+:/.exec(message)?.[0] ?? 'Provider:'} HTTP ${http[1]}`;
  return message.replace(/https?:\/\/\S+/g, '[URL]')
    .replace(/((?:token|password|secret|authorization)\s*[=:]\s*)[^\s,;}]+/gi, '$1[redacted]').slice(0, 280);
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?$/.exec(value);
  if (!match || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4] ?? 0) > 59 || !Number.isFinite(Date.parse(value))) return false;
  const day = new Date(`${match[1]}T00:00:00Z`);
  return Number.isFinite(day.getTime()) && day.toISOString().slice(0, 10) === match[1];
}

function extractSegments(provider: ProviderName, raw: any, query: SearchQuery): [Segment[], Segment[], (number | null)?] {
  if (provider === 'kiwi') {
    const sector = (value: any): Segment[] => (value?.sectorSegments ?? []).map((s: any) => ({
      from: s.segment?.source?.station?.code, to: s.segment?.destination?.station?.code,
      departure: s.segment?.source?.localTime, arrival: s.segment?.destination?.localTime ?? null,
      carrier: s.segment?.carrier?.code,
    }));
    return [sector(query.returnDate ? raw.outbound : raw.sector), query.returnDate ? sector(raw.inbound) : []];
  }
  if (provider === 'maxmilhas') {
    const sector = (bound: any): Segment[] => (bound?.segments ?? []).map((s: any) => ({
      from: s.departure?.locationCode, to: s.arrival?.locationCode,
      departure: s.departure?.dateTime, arrival: s.arrival?.dateTime ?? null,
      carrier: s.operatingAirlineCode ?? s.marketingAirlineCode,
    }));
    if (!Array.isArray(raw.bounds) || !raw.bounds.length || raw.bounds.some((b: any) => b?.number !== 0 && (b?.number !== 1 || !query.returnDate))) throw new Error('Unexpected itinerary bounds');
    // Bounds with the same number are alternatives within one priced offer.
    const select = (number: number, from: string, to: string, date: string) => {
      let reason = new Error('Missing itinerary direction');
      for (const bound of raw.bounds.filter((b: any) => b.number === number)) {
        try {
          const segments = sector(bound);
          validateSector(segments, from, to, date, query.maxStops ?? 2);
          return { bound, segments };
        } catch (error) { reason = error as Error; }
      }
      throw reason;
    };
    const out = select(0, query.origin, query.destination, query.departDate);
    const back = query.returnDate ? select(1, query.destination, query.origin, query.returnDate) : null;
    const selected = [out, ...(back ? [back] : [])];
    const checked = selected.every(s => typeof s.bound.hasCheckedBags === 'boolean')
      ? Math.min(...selected.map(s => s.bound.hasCheckedBags ? 1 : 0)) : null;
    return [out.segments, back?.segments ?? [], checked];
  }
  return [raw.segments ?? [], []];
}

function validateSector(segments: Segment[], from: string, to: string, date: string, maxStops: number) {
  if (!segments.length || segments[0].from !== from || segments.at(-1)!.to !== to) throw new Error('Itinerary does not match requested airports');
  if (segments[0].departure?.slice(0, 10) !== date) throw new Error('Itinerary does not match requested date');
  if (segments.length - 1 > maxStops) throw new Error('Itinerary exceeds max_stops');
  for (const [index, segment] of segments.entries()) {
    if (!domesticAirport(segment.from) || !domesticAirport(segment.to)) throw new Error('Itinerary includes an unknown or international airport');
    if (!ALLOWED_CARRIERS.has(segment.carrier)) throw new Error('Itinerary includes a carrier outside GOL, LATAM and Azul');
    if (!validTimestamp(segment.departure)) throw new Error('Missing or invalid departure time');
    if (segment.arrival !== null && !validTimestamp(segment.arrival)) throw new Error('Invalid arrival time');
    if (index && segments[index - 1].to !== segment.from) throw new Error('Airport change in connection requires manual review');
  }
}

export function normalizeQuote(source: ProviderName, offer: Offer, query: SearchQuery, retrievedAt: string): Quote {
  if (!Number.isFinite(offer.price) || offer.price <= 0 || minor(offer.price) <= 0 || !Number.isSafeInteger(minor(offer.price)) || offer.currency !== 'BRL') throw new Error('Invalid price or currency');
  if (offer.cabin !== 'ECONOMY') throw new Error('Only economy fares are supported');
  const raw = offer.raw as any;
  if (!raw || typeof raw !== 'object') throw new Error('Missing itinerary evidence');
  const [outbound, inbound, selectedBaggage] = extractSegments(source, raw, query);
  validateSector(outbound, query.origin, query.destination, query.departDate, query.maxStops ?? 2);
  const preview = source === 'google' && Boolean(query.returnDate);
  if (query.returnDate && !preview) validateSector(inbound, query.destination, query.origin, query.returnDate, query.maxStops ?? 2);
  if (source === 'maxmilhas') {
    const units = raw.priceDetails?.unitPrices;
    if (!Array.isArray(units) || units.length !== 1 || units[0].passengerTypeCode !== 'ADT' || !Number.isFinite(units[0].paxTotalAmount) || Math.abs(minor(units[0].paxTotalAmount * query.adults) - minor(offer.price)) > 1) throw new Error('Passenger total cannot be reconciled');
  }
  if (source === 'kiwi') {
    const link = offer.link ? new URL(offer.link) : null;
    if (link?.searchParams.get('passengers') !== `${query.adults}-0-0`) throw new Error('Booking link does not confirm the requested passenger count');
  }
  if (source === 'google' && raw.query_adults !== query.adults) throw new Error('Passenger count evidence is missing');
  const discounts = source === 'maxmilhas' ? raw.priceDetails.unitPrices.flatMap((u: any) => u.discounts ?? []) : [];
  const pix = discounts.some((d: any) => /pix/i.test(`${d.label ?? ''} ${d.name ?? ''}`));
  const warnings = (offer.warnings ?? []).map(safeDiagnostic);
  if (preview) warnings.push('Return flight is not selected: Google round-trip price is indicative and excluded from comparisons.');
  if (source === 'kiwi') warnings.push('Connections may involve separate tickets; transfer protection is not verified.');
  if (source === 'maxmilhas') warnings.push('Provider timestamps retain their original format; displayed local times may carry a Z suffix.');
  if (source === 'maxmilhas' && raw.bounds.length > (query.returnDate ? 2 : 1)) warnings.push('One valid alternative per direction was selected from a grouped fare; other combinations were not independently validated.');
  const identity = JSON.stringify({ source, query, outbound, inbound, price: minor(offer.price), pix });
  return {
    id: createHash('sha256').update(identity).digest('hex').slice(0, 24), source, retrieved_at: retrievedAt,
    price: { amount_minor: minor(offer.price), currency: 'BRL', scope: 'all_passengers', adults: query.adults },
    itinerary: { outbound, inbound, complete: !preview, time_basis: source === 'maxmilhas' ? 'provider_unverified_timezone' : 'airport_local' },
    airlines: [...new Set([...outbound, ...inbound].map(s => s.carrier))],
    conditions: { cabin: offer.cabin ?? 'unknown', checked_bags: source === 'maxmilhas' ? selectedBaggage ?? null : offer.checkedBags, payment: pix ? 'PIX' : 'unspecified', taxes_included: source === 'maxmilhas' ? true : null, transfer_protection: 'unknown' },
    comparison_eligible: !preview, booking_confirmed: false, link: source === 'kiwi' ? null : offer.link, warnings,
  };
}

export function compareQuotes(roundTrip: Quote[], outbound: Quote[], inbound: Quote[]) {
  const cheapest = (quotes: Quote[]) => quotes.filter(q => q.comparison_eligible).sort((a, b) => a.price.amount_minor - b.price.amount_minor)[0] ?? null;
  const rt = cheapest(roundTrip), out = cheapest(outbound), back = cheapest(inbound);
  const separate = out && back ? out.price.amount_minor + back.price.amount_minor : null;
  const difference = rt && separate !== null ? rt.price.amount_minor - separate : null;
  return {
    level: 'observed_price_only', currency: 'BRL', conditions_comparable: false, exhaustive: false,
    round_trip: rt ? { quote_id: rt.id, total_minor: rt.price.amount_minor } : null,
    separate: out && back ? { outbound_quote_id: out.id, inbound_quote_id: back.id, total_minor: separate, separate_bookings: true } : null,
    round_trip_minus_separate_minor: difference,
    lower_observed_price: difference === null ? null : difference > 0 ? 'separate' : difference < 0 ? 'round_trip' : 'tie',
    warning: 'Prices may have different payment, baggage, connection and refund conditions. No global minimum or booking availability is guaranteed.',
  };
}
