import assert from 'node:assert/strict';
import { describe, it, TestContext } from 'node:test';
import { kiwi } from '../src/providers/kiwi';
import { maxmilhas } from '../src/providers/maxmilhas';
import { ProviderError, SearchQuery } from '../src/providers/types';

const query: SearchQuery = {
  origin: 'CNF', destination: 'REC', departDate: '2027-03-10',
  returnDate: '2027-03-17', adults: 2,
};

// Reduced shapes from the 2026-11-24 responses; IDs and booking tokens are omitted.
const segment = (from: string, to: string, date: string, carrier: string) => ({
  segment: {
    source: { localTime: `${date}T15:05:00`, station: { code: from } },
    destination: { localTime: `${date}T16:30:00`, station: { code: to } },
    carrier: { code: carrier, name: carrier },
  },
});

function kiwiOffer(): any {
  return {
    cabinClasses: ['ECONOMY'],
    price: { amount: '2685', currency: { code: 'BRL' } },
    bagsInfo: { includedCheckedBags: 0, includedHandBags: 2 },
    outbound: { sectorSegments: [
      segment('CNF', 'CGH', '2027-03-10', 'G3'), segment('CGH', 'REC', '2027-03-10', 'AD'),
    ] },
    inbound: { sectorSegments: [
      segment('REC', 'BSB', '2027-03-17', 'LA'), segment('BSB', 'CNF', '2027-03-17', 'AD'),
    ] },
    bookingOptions: { edges: [] },
  };
}

const kiwiBody = (itineraries: any[], roundTrip = true) => ({
  data: { [roundTrip ? 'returnItineraries' : 'onewayItineraries']: { __typename: 'Itineraries', itineraries } },
});

function maxOffer(): any {
  return {
    type: 'miles', cabin: 'EC',
    priceDetails: {
      unitPrices: [{
        passengerTypeCode: 'ADT', currencyCode: 'BRL', paxBaseAmount: 1400,
        paxTotalTaxes: 95.69, paxTotalAmount: 1332.69, paxTotalFees: 5, paxTotalDiscounts: 168,
        discounts: [
          { code: 'SCROOGE_DISCOUNT', currencyCode: 'BRL', amount: 86.64, label: 'no PIX', name: 'pix', boundNumber: 0 },
          { code: 'SCROOGE_DISCOUNT', currencyCode: 'BRL', amount: 81.36, label: 'no PIX', name: 'pix', boundNumber: 1 },
        ],
      }],
      totalPrices: { base: 2800, total: 2665.38, currencyCode: 'BRL', totalTaxes: 191.38, totalFees: 10, totalDiscounts: 336 },
    },
    bounds: [
      { number: 0, carrier: 'azul', hasCheckedBags: false, totalStops: 0, departure: { dateTime: '2027-03-10T09:45:00' } },
      { number: 1, carrier: 'azul', hasCheckedBags: false, totalStops: 0, departure: { dateTime: '2027-03-17T02:50:00' } },
    ],
    thirdPartyOffers: [{ provider: 'airline', currencyCode: 'BRL', amount: 3244.34, fareOptions: [] }],
  };
}

const maxBody = (offers: any[]) => ({ offers, dictionaries: { airline: { azul: 'azul' } } });
const intentionHtml = (airlines: any = ['azul']) => `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
  props: { pageProps: { searchIntention: {
    id: 'test-search',
    airlines: Array.isArray(airlines) ? airlines.map((label: string) => ({ label, status: { enable: true } })) : airlines,
  } } },
})}</script>`;

function mockKiwi(t: TestContext, body: unknown, inspect?: (init?: RequestInit) => void) {
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    inspect?.(init);
    return new Response(JSON.stringify(body), { status: 200 });
  });
}

function mockMax(t: TestContext, bodies: Record<string, unknown | Response>, airlines = Object.keys(bodies), inspect?: (url: string) => void) {
  t.mock.method(globalThis, 'fetch', async (url: unknown) => {
    const address = String(url);
    inspect?.(address);
    if (address.startsWith('https://www.maxmilhas.com.br/')) return new Response(intentionHtml(airlines));
    const body = bodies[address.split('/').at(-1)!];
    if (body === undefined) return new Response('unexpected test request', { status: 404 });
    return body instanceof Response ? body : new Response(JSON.stringify(body));
  });
}

describe('Kiwi response contract', () => {
  it('keeps the observed group total, raw conditions and requested adults', async (t) => {
    const raw = kiwiOffer();
    mockKiwi(t, kiwiBody([raw]), (init) => {
      const request = JSON.parse(String(init?.body));
      assert.deepEqual(request.variables.search.passengers, { adults: 2, children: 0, infants: 0 });
      assert.equal(request.variables.options.currency, 'brl');
    });
    const [offer] = await kiwi.search(query);
    assert.equal(offer.price, 2685);
    assert.equal(offer.currency, 'BRL');
    assert.equal(offer.checkedBags, 0);
    assert.deepEqual(offer.raw, raw);
  });

  it('supports one-way responses and preserves unknown baggage as null', async (t) => {
    const raw = kiwiOffer();
    raw.sector = raw.outbound;
    delete raw.outbound;
    delete raw.inbound;
    delete raw.bagsInfo;
    mockKiwi(t, kiwiBody([raw], false));
    const [offer] = await kiwi.search({ ...query, returnDate: null });
    assert.equal(offer.checkedBags, null);
    assert.equal(offer.returnAt, null);
  });

  it('does not accept invalid, non-positive, non-BRL or unspecified-currency prices', async (t) => {
    const invalid = [0, -10, 'NaN', 'Infinity', null, true, {}].map((amount) => {
      const raw = kiwiOffer(); raw.price.amount = amount; return raw;
    });
    for (const code of ['USD', null]) {
      const raw = kiwiOffer(); raw.price.currency.code = code; invalid.push(raw);
    }
    mockKiwi(t, kiwiBody([...invalid, kiwiOffer()]));
    assert.equal((await kiwi.search(query)).length, 1);
  });

  it('throws when a non-empty response has no valid prices', async (t) => {
    const raw = kiwiOffer(); raw.price.amount = 'Infinity';
    mockKiwi(t, kiwiBody([raw]));
    await assert.rejects(kiwi.search(query), /preco positivo finito em BRL/);
  });

  it('accepts an explicitly empty result', async (t) => {
    mockKiwi(t, kiwiBody([]));
    assert.deepEqual(await kiwi.search(query), []);
  });

  for (const [name, body] of [
    ['missing result', {}],
    ['wrong collection', { data: { returnItineraries: { __typename: 'Itineraries', itineraries: {} } } }],
    ['unknown union member', { data: { returnItineraries: { __typename: 'NewResult', itineraries: [] } } }],
    ['malformed item', kiwiBody([null])],
    ['malformed segments', kiwiBody([{ ...kiwiOffer(), outbound: { sectorSegments: {} } }])],
  ] as const) {
    it(`rejects ${name} as a provider error`, async (t) => {
      mockKiwi(t, body);
      await assert.rejects(kiwi.search(query), ProviderError);
    });
  }
});

describe('MaxMilhas response contract', () => {
  it('finds the return direction after multiple outbound alternatives', async (t) => {
    const raw = maxOffer();
    raw.bounds = [raw.bounds[0], structuredClone(raw.bounds[0]), raw.bounds[1]];
    mockMax(t, { azul: maxBody([raw]) });
    const [offer] = await maxmilhas.search(query);
    assert.equal(offer.returnAt, '2027-03-17T02:50:00');
    assert.equal(offer.price, 2665.38);
  });
  it('keeps the observed two-adult PIX total without multiplying it again', async (t) => {
    const raw = maxOffer();
    const urls: string[] = [];
    mockMax(t, { azul: { ...maxBody([raw]), offersUpsell: [{ priceDetails: { totalPrices: { total: 1 } } }] } }, ['azul'], (url) => urls.push(url));
    const [offer] = await maxmilhas.search(query);
    assert.match(urls[0], /\/RT\/CNF\/REC\/2027-03-10\/2027-03-17\/2\/0\/0\/EC$/);
    assert.equal(raw.priceDetails.unitPrices[0].paxTotalAmount * query.adults, 2665.38);
    assert.equal(offer.price, 2665.38);
    assert.equal(offer.currency, 'BRL');
    assert.equal(offer.checkedBags, 0);
    assert.deepEqual(offer.raw, raw);
    assert.equal((offer.raw as any).priceDetails.unitPrices[0].discounts[0].label, 'no PIX');
    assert.equal(offer.warnings, undefined);
  });

  it('does not replace the public offer with a cheaper nested alternative', async (t) => {
    const raw = maxOffer(); raw.thirdPartyOffers[0].amount = 1;
    mockMax(t, { azul: maxBody([raw]) });
    assert.equal((await maxmilhas.search(query))[0].price, 2665.38);
  });

  it('keeps unspecified baggage and airline unknown', async (t) => {
    const raw = maxOffer(); delete raw.bounds[0].hasCheckedBags; delete raw.bounds[0].carrier;
    mockMax(t, { azul: maxBody([raw]) });
    const [offer] = await maxmilhas.search(query);
    assert.equal(offer.checkedBags, null);
    assert.equal(offer.airline, null);
  });

  it('queries only azul, gol, latam and mix, without duplicate requests', async (t) => {
    const seen: string[] = [];
    const bodies = Object.fromEntries(['azul', 'gol', 'latam', 'mix'].map((airline) => [airline, maxBody([maxOffer()])]));
    mockMax(t, bodies, ['azul', 'gol', 'latam', 'mix', 'tap', 'others', 'azul'], (url) => seen.push(url));
    assert.equal((await maxmilhas.search(query)).length, 4);
    assert.deepEqual(seen.slice(1).map((url) => url.split('/').at(-1)).sort(), ['azul', 'gol', 'latam', 'mix']);
  });

  it('attaches per-airline HTTP and structural failures to successful offers', async (t) => {
    mockMax(t, { azul: maxBody([maxOffer()]), gol: new Response('blocked', { status: 403 }), latam: { error: 'changed shape' } });
    const [offer] = await maxmilhas.search(query);
    assert.equal(offer.warnings?.length, 2);
    assert.match(offer.warnings![0], /maxmilhas\/gol: HTTP 403/);
    assert.match(offer.warnings![1], /maxmilhas\/latam: formato inesperado/);
  });

  it('rejects invalid prices and currencies while retaining valid offers', async (t) => {
    const invalid = [0, -10, 'NaN', 'Infinity', null, true, {}].map((total) => {
      const raw = maxOffer(); raw.priceDetails.totalPrices.total = total; return raw;
    });
    for (const currencyCode of ['USD', null]) {
      const raw = maxOffer(); raw.priceDetails.totalPrices.currencyCode = currencyCode; invalid.push(raw);
    }
    mockMax(t, { azul: maxBody([...invalid, maxOffer()]) });
    assert.equal((await maxmilhas.search(query)).length, 1);
  });

  it('reports an airline whose non-empty response has only invalid prices', async (t) => {
    const raw = maxOffer(); raw.priceDetails.totalPrices.total = 'Infinity';
    mockMax(t, { azul: maxBody([maxOffer()]), gol: maxBody([raw]) });
    assert.match((await maxmilhas.search(query))[0].warnings![0], /maxmilhas\/gol: nenhuma oferta com preco positivo/);
  });

  it('does not hide all-airline failures as an empty result', async (t) => {
    mockMax(t, { azul: { offers: {} }, gol: new Response('blocked', { status: 403 }) });
    await assert.rejects(maxmilhas.search(query), (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.match(error.message, /maxmilhas\/azul: formato inesperado/);
      assert.match(error.message, /maxmilhas\/gol: HTTP 403/);
      return true;
    });
  });

  it('accepts explicitly empty airline results', async (t) => {
    mockMax(t, { azul: maxBody([]), gol: maxBody([]) });
    assert.deepEqual(await maxmilhas.search(query), []);
  });

  it('rejects a changed search-intention airline structure', async (t) => {
    t.mock.method(globalThis, 'fetch', async () => new Response(intentionHtml({ azul: true })));
    await assert.rejects(maxmilhas.search(query), /formato inesperado da lista de companhias/);
  });

  it('rejects malformed offer structure', async (t) => {
    mockMax(t, { azul: maxBody([null]) });
    await assert.rejects(maxmilhas.search(query), /formato inesperado de uma oferta/);
  });
});
