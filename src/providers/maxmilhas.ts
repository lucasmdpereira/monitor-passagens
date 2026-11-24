import { fetchJson, fetchText, Offer, PriceProvider, ProviderError, SearchQuery } from './types';

/**
 * MaxMilhas — API interna (BFF) do site, sem cadastro nem chave.
 *
 * O fluxo tem duas etapas, igual ao do proprio site:
 *   1. GET na pagina de busca  -> o servidor cria uma "searchIntention" (UUID)
 *      e informa quais companhias estao habilitadas para a rota;
 *   2. GET /search/air-offer/offers/{id}/{cia} no BFF, uma vez por companhia.
 *
 * Cobre GOL, LATAM e Azul com tarifa brasileira, incluindo tarifas que so
 * aparecem nos sites das companhias. Como e endpoint interno, pode mudar sem
 * aviso — todo o acoplamento esta neste arquivo.
 */

const SITE = 'https://www.maxmilhas.com.br';
const BFF = 'https://bff-mall.maxmilhas.com.br';
const ALLOWED_AIRLINES = new Set(['azul', 'gol', 'latam', 'mix']);
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** /busca-passagens-aereas/OW/FOR/SSA/2026-10-08/1/0/0/EC */
function pageUrl(query: SearchQuery): string {
  const parts = [
    'busca-passagens-aereas',
    query.returnDate ? 'RT' : 'OW',
    query.origin.toUpperCase(),
    query.destination.toUpperCase(),
    query.departDate,
    ...(query.returnDate ? [query.returnDate] : []),
    String(query.adults),
    '0', // criancas
    '0', // bebes
    'EC',
  ];
  return `${SITE}/${parts.join('/')}`;
}

interface Intention {
  id: string;
  airlines: string[];
}

async function createIntention(url: string): Promise<Intention> {
  /* Esta e a porta de entrada da MaxMilhas: uma pagina HTML do site, nao uma
     API. E tambem a chamada mais sujeita a bloqueio, entao ela merece a mesma
     retentativa com espera crescente que o resto. */
  let html: string;
  try {
    html = await fetchText(url, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'pt-BR,pt;q=0.9', Accept: 'text/html' },
      timeoutMs: 30_000,
    });
  } catch (err) {
    throw new ProviderError(`pagina de busca falhou: ${(err as Error).message}`, 'maxmilhas');
  }
  const embedded = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (!embedded) {
    throw new ProviderError('pagina sem __NEXT_DATA__ (o site da MaxMilhas mudou)', 'maxmilhas');
  }

  let intention: any;
  try {
    intention = JSON.parse(embedded[1])?.props?.pageProps?.searchIntention;
  } catch {
    throw new ProviderError('__NEXT_DATA__ nao e JSON valido', 'maxmilhas');
  }

  if (typeof intention?.id !== 'string' || !intention.id.trim()) {
    throw new ProviderError('o site nao criou a busca (rota ou data invalida?)', 'maxmilhas');
  }

  if (!Array.isArray(intention.airlines)) {
    throw new ProviderError('formato inesperado da lista de companhias', 'maxmilhas');
  }
  const airlines = [...new Set<string>(intention.airlines
    .filter((a: any) => a?.status?.enable === true && typeof a.label === 'string')
    .map((a: any) => a.label.trim().toLowerCase())
    .filter((label: string) => ALLOWED_AIRLINES.has(label)))];

  if (airlines.length === 0) {
    throw new ProviderError('nenhuma companhia habilitada para esta rota', 'maxmilhas');
  }

  return { id: intention.id, airlines };
}

async function fetchAirline(id: string, airline: string, referer: string): Promise<any> {
  return fetchJson(`${BFF}/search/air-offer/offers/${encodeURIComponent(id)}/${airline}`, {
    headers: {
      'User-Agent': UA,
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'pt-BR,pt;q=0.9',
      Origin: SITE,
      Referer: referer,
    },
    // O proprio site permite ate 120s por companhia.
    timeoutMs: 125_000,
  });
}

const CABIN: Record<string, string> = {
  EC: 'ECONOMY',
  PE: 'PREMIUM_ECONOMY',
  EX: 'BUSINESS',
  BU: 'BUSINESS',
};

/** O dicionario devolve o apelido em minusculas ("gol"); aqui vira nome de exibicao. */
const AIRLINE_NAMES: Record<string, string> = {
  gol: 'GOL',
  latam: 'LATAM',
  azul: 'Azul',
  tap: 'TAP',
  copa: 'Copa Airlines',
  G3: 'GOL',
  LA: 'LATAM',
  AD: 'Azul',
};

function airlineName(code: unknown, dictionaries: any): string | null {
  if (typeof code !== 'string' || !code) return null;
  const entry = dictionaries?.airline?.[code];
  const name = typeof entry === 'string' ? entry : entry?.name;
  const raw = typeof name === 'string' && name ? name : code;
  return AIRLINE_NAMES[raw] ?? AIRLINE_NAMES[code] ?? raw.replace(/\b[a-z]/g, (c: string) => c.toUpperCase());
}

function toOffer(raw: any, dictionaries: any, link: string): Offer | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
    || !raw.priceDetails || typeof raw.priceDetails !== 'object'
    || !Array.isArray(raw.bounds) || !raw.bounds[0] || typeof raw.bounds[0] !== 'object') {
    throw new ProviderError('formato inesperado de uma oferta da MaxMilhas', 'maxmilhas');
  }
  const total = raw?.priceDetails?.totalPrices;
  const out = raw.bounds.find((bound: any) => bound?.number === 0);
  if (!out) throw new ProviderError('oferta sem direcao de ida identificada', 'maxmilhas');
  if (!total || typeof total !== 'object' || Array.isArray(total)) {
    throw new ProviderError('formato inesperado do total da oferta', 'maxmilhas');
  }
  if (typeof total.total !== 'number' && typeof total.total !== 'string') return null;
  const price = Number(total.total);
  if (!Number.isFinite(price) || price <= 0
    || typeof total.currencyCode !== 'string' || total.currencyCode.trim().toUpperCase() !== 'BRL') {
    return null;
  }

  const back = raw.bounds.find((bound: any) => bound?.number === 1);
  const code = out.carrier ?? out.validatedBy;

  return {
    // The group total already includes the discounts in raw.priceDetails.
    price,
    currency: 'BRL',
    airline: airlineName(code, dictionaries),
    cabin: CABIN[raw.cabin] ?? raw.cabin ?? 'ECONOMY',
    checkedBags: typeof out.hasCheckedBags === 'boolean' ? (out.hasCheckedBags ? 1 : 0) : null,
    stopsOut: typeof out.totalStops === 'number' ? out.totalStops : null,
    stopsRet: back && typeof back.totalStops === 'number' ? back.totalStops : null,
    departAt: out.departure?.dateTime ?? null,
    returnAt: back?.departure?.dateTime ?? null,
    link,
    raw,
  };
}

export const maxmilhas: PriceProvider = {
  name: 'maxmilhas',

  isConfigured() {
    return true;
  },

  async search(query: SearchQuery): Promise<Offer[]> {
    const url = pageUrl(query);
    const intention = await createIntention(url);

    const perAirline = await Promise.all(
      intention.airlines.map(async (airline) => {
        try {
          const body = await fetchAirline(intention.id, airline, url);
          if (!Array.isArray(body?.offers)) {
            throw new ProviderError('formato inesperado dos resultados da MaxMilhas', 'maxmilhas');
          }
          const rawOffers: any[] = body.offers;
          const offers = rawOffers
            .map((o) => toOffer(o, body?.dictionaries, url))
            .filter((o): o is Offer => o !== null);
          if (rawOffers.length > 0 && offers.length === 0) {
            throw new ProviderError('nenhuma oferta com preco positivo finito em BRL', 'maxmilhas');
          }
          return { offers, warning: null };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { offers: [] as Offer[], warning: `maxmilhas/${airline}: ${message}` };
        }
      }),
    );

    const all = perAirline.flatMap((result) => result.offers);
    const warnings = perAirline.flatMap((result) => result.warning ? [result.warning] : []);
    if (all.length === 0) {
      if (warnings.length > 0) {
        throw new ProviderError(`nenhuma companhia retornou ofertas: ${warnings.join(' | ')}`, 'maxmilhas');
      }
      return [];
    }
    if (warnings.length > 0) for (const offer of all) offer.warnings = [...warnings];
    return all;
  },
};
