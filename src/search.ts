import { planSearch, type ProviderName, type Request } from './request';
import { normalizeQuote, compareQuotes, safeDiagnostic, type Quote } from './quotes';
import { kiwi } from './providers/kiwi';
import { maxmilhas } from './providers/maxmilhas';
import { google } from './providers/google';
import type { PriceProvider, SearchQuery } from './providers/types';

export { planSearch, normalizeRequest, DEFAULT_ORIGINS } from './request';
export type { Request, ProviderName } from './request';
export type { Quote } from './quotes';
type Kind = 'round_trip' | 'outbound_one_way' | 'inbound_one_way';
const registry: Record<ProviderName, PriceProvider> = { kiwi, maxmilhas, google };

export function buildQueries(origin: string, destination: string, request: Request) {
  const base: SearchQuery = { origin, destination, departDate: request.departure_date,
    returnDate: request.return_date, adults: request.passengers.adults, maxStops: request.max_stops };
  return [
    { kind: 'round_trip' as Kind, query: base },
    { kind: 'outbound_one_way' as Kind, query: { ...base, returnDate: null } },
    { kind: 'inbound_one_way' as Kind, query: { ...base, origin: destination, destination: origin,
      departDate: request.return_date, returnDate: null } },
  ];
}

interface QueryResult {
  provider: ProviderName;
  kind: Kind;
  query: SearchQuery;
  status: 'ok' | 'partial' | 'empty' | 'error' | 'blocked' | 'skipped';
  elapsed_ms: number;
  received_offers: number;
  rejected_offers: number;
  offers: Quote[];
  warnings: string[];
  error?: { code: string; message: string };
}

function failure(error: unknown) {
  const e = error as any;
  const message = error instanceof Error ? error.message : 'Unknown provider failure';
  const http = /HTTP\s+(\d{3})/.exec(message)?.[1];
  const code = e?.code ?? (http ? `HTTP_${http}` : e?.name === 'AbortError' ? 'TIMEOUT' : 'PROVIDER_ERROR');
  // HTTP bodies can contain identifiers. Keep diagnostics useful without persisting them.
  return { code: String(code), message: http ? `Provider returned HTTP ${http}` : safeDiagnostic(message) };
}

export async function searchFlights(input: unknown, dependencies: { providers?: Record<ProviderName, PriceProvider>; now?: () => Date } = {}) {
  const started = new Date();
  const plan = planSearch(input);
  const providers = dependencies.providers ?? registry;
  const now = dependencies.now ?? (() => new Date());
  const routes: Array<{ origin: string; destination: string; queries: QueryResult[]; comparison: ReturnType<typeof compareQuotes> }> = [];
  const blockedSources = new Set<ProviderName>();
  for (const route of plan.routes) {
    const results: QueryResult[] = [];
    for (const providerName of plan.request.providers) {
      for (const { kind, query } of buildQueries(route.origin, route.destination, plan.request)) {
        const entry: QueryResult = { provider: providerName, kind, query, status: 'empty', elapsed_ms: 0,
          received_offers: 0, rejected_offers: 0, offers: [], warnings: [] };
        if (blockedSources.has(providerName)) {
          entry.status = 'skipped';
          entry.error = { code: 'SOURCE_BLOCKED', message: 'Skipped after an access block in this batch' };
          results.push(entry);
          continue;
        }
        const queryStarted = Date.now();
        try {
          const offers = await providers[providerName].search(query);
          const retrieved = now().toISOString();
          entry.received_offers = offers.length;
          const seen = new Set<string>();
          for (const offer of offers) {
            try {
              const normalized = normalizeQuote(providerName, offer, query, retrieved);
              if (!seen.has(normalized.id)) entry.offers.push(normalized);
              seen.add(normalized.id);
              entry.warnings.push(...(offer.warnings ?? []).map(safeDiagnostic));
            } catch (error) {
              entry.rejected_offers++;
              entry.warnings.push(error instanceof Error ? error.message : 'Invalid offer');
            }
          }
          entry.offers.sort((a, b) => a.price.amount_minor - b.price.amount_minor);
          entry.warnings = [...new Set(entry.warnings)];
          entry.status = !entry.offers.length ? (offers.length ? 'error' : 'empty')
            : entry.rejected_offers || entry.warnings.length || entry.offers.some(o => !o.comparison_eligible) ? 'partial' : 'ok';
          if (offers.length && !entry.offers.length) entry.error = { code: 'NO_VALID_OFFERS', message: 'All returned offers failed itinerary or price validation' };
        } catch (error) {
          entry.error = failure(error);
          entry.status = ['HTTP_403', 'HTTP_429'].includes(entry.error.code) ? 'blocked' : 'error';
          if (entry.status === 'blocked') blockedSources.add(providerName);
        }
        entry.elapsed_ms = Date.now() - queryStarted;
        results.push(entry);
      }
    }
    const quotesFor = (kind: Kind) => results.filter(r => r.kind === kind).flatMap(r => r.offers);
    routes.push({ ...route, queries: results,
      comparison: compareQuotes(quotesFor('round_trip'), quotesFor('outbound_one_way'), quotesFor('inbound_one_way')) });
  }
  const queries = routes.flatMap(r => r.queries);
  const usefulOffers = queries.flatMap(q => q.offers).filter(o => o.comparison_eligible).length;
  const status = usefulOffers ? (queries.every(q => q.status === 'ok') && plan.next_cursor === null ? 'ok' : 'partial')
    : queries.every(q => q.status === 'empty') ? 'empty' : 'error';
  return {
    schema_version: '1.0', status, started_at: started.toISOString(), finished_at: now().toISOString(),
    request: plan.request,
    coverage: { total_routes: plan.total_routes, routes_processed: routes.length, cursor: plan.cursor,
      next_cursor: plan.next_cursor, batch_reaches_end: plan.complete, exhaustive: false,
      source_type: 'aggregators', airlines_allowed: ['G3', 'LA', 'JJ', 'AD'],
      note: 'The airport catalog is not proof of active airline service. A batch does not search all published inventory.' },
    routes,
  };
}
