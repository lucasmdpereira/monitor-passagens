import { readFileSync } from 'node:fs';
import { join } from 'node:path';

interface Airport { iata: string; country: string; scheduled_service: boolean }
const catalog = JSON.parse(readFileSync(join(__dirname, '../catalog/brazil-airports.json'), 'utf8'));
const airports: Airport[] = catalog.airports;
const codes = new Set(airports.filter(a => a.country === 'BR').map(a => a.iata));
export const DEFAULT_ORIGINS = ['CNF', 'PLU', 'GIG', 'SDU', 'GRU', 'CGH', 'VCP'];
export const PROVIDERS = ['kiwi', 'maxmilhas', 'google'] as const;
export type ProviderName = typeof PROVIDERS[number];
export const domesticAirport = (code: string) => codes.has(code);

export interface Request {
  origins: string[];
  destinations: string[];
  departure_date: string;
  return_date: string;
  passengers: { adults: number };
  providers: ProviderName[];
  max_stops: number;
  max_routes: number;
  cursor: number;
}

function integer(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new TypeError(`${label}: expected an integer between ${min} and ${max}`);
  }
  return value;
}

function airportList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.length) throw new TypeError(`${label}: expected a nonempty array`);
  const list = value.map(code => {
    if (typeof code !== 'string' || !domesticAirport(code.toUpperCase())) {
      throw new TypeError(`${label}: unknown Brazilian airport ${String(code)}`);
    }
    return code.toUpperCase();
  });
  return [...new Set(list)];
}

export function normalizeRequest(input: unknown, today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })): Request {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Expected a search object');
  const data = input as Record<string, unknown>;
  const allowed = ['origins', 'destinations', 'departure_date', 'return_date', 'passengers', 'providers', 'max_stops', 'max_routes', 'cursor'];
  for (const key of Object.keys(data)) if (!allowed.includes(key)) throw new TypeError(`Unknown input field: ${key}`);
  for (const key of ['departure_date', 'return_date']) {
    const date = data[key];
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) {
      throw new TypeError(`${key}: expected a real YYYY-MM-DD date`);
    }
  }
  const departure = data.departure_date as string;
  const back = data.return_date as string;
  if (departure < today || back < departure) throw new TypeError('Dates must be future dates with return on or after departure');
  let adults: unknown = data.passengers ?? 2;
  if (typeof adults === 'object' && adults !== null && !Array.isArray(adults)) {
    const passengers = adults as Record<string, unknown>;
    if (Object.keys(passengers).some(key => key !== 'adults')) throw new TypeError('Only adult passengers are supported');
    adults = passengers.adults ?? 2;
  }
  const providers = data.providers ?? [...PROVIDERS];
  if (!Array.isArray(providers) || !providers.length || providers.some(p => !PROVIDERS.includes(p))) {
    throw new TypeError('providers: expected kiwi, maxmilhas and/or google');
  }
  return {
    origins: airportList(data.origins ?? DEFAULT_ORIGINS, 'origins'),
    destinations: airportList(data.destinations ?? [...airports].sort((a, b) => Number(b.scheduled_service) - Number(a.scheduled_service) || a.iata.localeCompare(b.iata)).map(a => a.iata), 'destinations'),
    departure_date: departure,
    return_date: back,
    passengers: { adults: integer(adults, 'passengers.adults', 1, 9) },
    providers: [...new Set(providers)] as ProviderName[],
    max_stops: integer(data.max_stops ?? 2, 'max_stops', 0, 2),
    max_routes: integer(data.max_routes ?? 1, 'max_routes', 1, 100),
    cursor: integer(data.cursor ?? 0, 'cursor', 0, Number.MAX_SAFE_INTEGER),
  };
}

export function planSearch(input: unknown) {
  const request = normalizeRequest(input);
  const all = request.origins.flatMap(origin => request.destinations.filter(destination => destination !== origin).map(destination => ({ origin, destination })));
  if (!all.length) throw new TypeError('No routes remain after removing identical airports');
  if (request.cursor >= all.length) throw new TypeError('cursor is outside the search plan');
  const end = Math.min(request.cursor + request.max_routes, all.length);
  return { request, routes: all.slice(request.cursor, end), total_routes: all.length,
    cursor: request.cursor, next_cursor: end < all.length ? end : null, complete: end === all.length };
}
