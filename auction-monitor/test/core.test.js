const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'am-test-'));

const { calculateTotal, evaluateDeal } = require('../src/costs');
const { DEFAULT_SETTINGS } = require('../src/settings');
const { computeStats, marketValueFromStats, isComparable } = require('../src/market');
const { parseOtomotoHtml } = require('../src/market/otomoto');
const { parseOlxResponse, buildApiUrl } = require('../src/market/olx');
const { parseAuctionHtml, parseDate } = require('../src/auctions');
const { parseNumber, slugify } = require('../src/http');

const rates = { CHF: 4.5, EUR: 4.3, PLN: 1 };

test('kalkulacja kosztów: kolejność pozycji i procent narastająco', () => {
  const costs = [
    { name: 'Transport', type: 'fixed', amount: 1000, currency: 'PLN' },
    { name: 'Cło', type: 'percent', pct: 10, base: 'running' },
    { name: 'VAT', type: 'percent', pct: 23, base: 'running' },
  ];
  const r = calculateTotal(10000, { currency: 'CHF', costs, rates });
  // 45000 + 1000 = 46000; cło 4600 → 50600; VAT 11638 → 62238
  assert.strictEqual(r.pricePln, 45000);
  assert.strictEqual(r.totalPln, 62238);
  assert.deepStrictEqual(r.items.map((i) => i.amountPln), [1000, 4600, 11638]);
});

test('akcyza zależna od pojemności; nieznana pojemność = wariant ostrożny', () => {
  const costs = DEFAULT_SETTINGS.costs;
  const small = calculateTotal(10000, { currency: 'CHF', engineCc: 1995, costs, rates });
  const big = calculateTotal(10000, { currency: 'CHF', engineCc: 2993, costs, rates });
  const unknown = calculateTotal(10000, { currency: 'CHF', costs, rates });
  assert.ok(small.items.some((i) => i.name.includes('do 1999')));
  assert.ok(!small.items.some((i) => i.name.includes('od 2000')));
  assert.ok(big.totalPln > small.totalPln);
  assert.strictEqual(unknown.totalPln, big.totalPln);
});

test('ocena okazji i maksymalna stawka', () => {
  const costs = [{ name: 'VAT', type: 'percent', pct: 23, base: 'running' }];
  const e = evaluateDeal({ price: 10000, currency: 'CHF', costs, rates, marketValuePln: 90000, thresholdPct: 30 });
  // koszt 55350; rynek 90000 → 38.5% taniej
  assert.strictEqual(e.totalPln, 55350);
  assert.strictEqual(e.discountPct, 38.5);
  assert.strictEqual(e.isDeal, true);
  // maks. stawka: 90000*0.7 = 63000 / (4.5*1.23) = 11382
  assert.strictEqual(e.maxBid, 11382);
  const atMax = evaluateDeal({ price: e.maxBid, currency: 'CHF', costs, rates, marketValuePln: 90000, thresholdPct: 30 });
  assert.ok(atMax.isDeal);
  const above = evaluateDeal({ price: e.maxBid + 10, currency: 'CHF', costs, rates, marketValuePln: 90000, thresholdPct: 30 });
  assert.ok(!above.isDeal);
});

test('statystyki rynkowe odrzucają wartości odstające', () => {
  const listings = [70000, 72000, 74000, 75000, 76000, 78000, 15000, 250000].map((p) => ({ pricePln: p }));
  const s = computeStats(listings);
  assert.strictEqual(s.count, 6);
  assert.strictEqual(s.median, 74500);
  const v = marketValueFromStats(s, { minListings: 3, statistic: 'median', askingPriceDiscountPct: 5 });
  assert.strictEqual(v, Math.round(74500 * 0.95));
  assert.strictEqual(marketValueFromStats(s, { minListings: 10 }), null);
});

test('porównywalność: rocznik i przebieg', () => {
  const car = { year: 2018, mileageKm: 100000 };
  const opts = { yearTolerance: 1, mileageTolerancePct: 30 };
  assert.ok(isComparable({ year: 2019, mileageKm: 120000, pricePln: 50000 }, car, opts));
  assert.ok(!isComparable({ year: 2016, mileageKm: 100000, pricePln: 50000 }, car, opts));
  assert.ok(!isComparable({ year: 2018, mileageKm: 200000, pricePln: 50000 }, car, opts));
});

test('parser Otomoto (__NEXT_DATA__ z urqlState)', () => {
  const gql = {
    data: {
      advertSearch: {
        edges: [
          { node: { id: '1', title: 'BMW 320d', url: 'https://www.otomoto.pl/osobowe/oferta/a-1', price: { amount: { units: 79900, currencyCode: 'PLN' } }, parameters: [{ key: 'year', value: '2018' }, { key: 'mileage', value: '120000', displayValue: '120 000 km' }] } },
          { node: { id: '2', title: 'BMW 318d', url: 'https://www.otomoto.pl/osobowe/oferta/a-2', price: { amount: { units: 69500, currencyCode: 'PLN' } }, parameters: [{ key: 'year', value: '2019' }] } },
        ],
      },
    },
  };
  const next = { props: { pageProps: { urqlState: { abc: { data: JSON.stringify(gql) } } } } };
  const html = `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(next)}</script></html>`;
  const l = parseOtomotoHtml(html);
  assert.strictEqual(l.length, 2);
  assert.deepStrictEqual(
    l.map((x) => [x.price, x.year, x.mileageKm]),
    [[79900, 2018, 120000], [69500, 2019, null]]
  );
});

test('parser OLX', () => {
  const json = {
    data: [
      { id: 11, title: 'BMW 320d F31', url: 'https://www.olx.pl/d/oferta/x', params: [{ key: 'price', value: { value: 72000, currency: 'PLN' } }, { key: 'year', value: { key: '2018' } }, { key: 'milage', value: { key: '130000' } }] },
      { id: 12, title: 'Zamienię', params: [{ key: 'price', value: { value: 0 } }] },
    ],
  };
  const l = parseOlxResponse(json);
  assert.strictEqual(l.length, 1);
  assert.deepStrictEqual([l[0].price, l[0].year, l[0].mileageKm], [72000, 2018, 130000]);
  assert.match(buildApiUrl({ make: 'BMW', model: '320d', year: 2018, mileageKm: 100000 }), /filter_float_milage%3Ato=135000/);
});

test('parser strony aukcji: selektory, JSON-LD, daty szwajcarskie', () => {
  const html = `<div class="bid">CHF 12'500.–</div><span class="end">24.11.2026 18:30</span>`;
  const r = parseAuctionHtml(html, { priceSelector: '.bid', endTimeSelector: '.end' });
  assert.strictEqual(r.price, 12500);
  assert.strictEqual(r.endsAt, '2026-11-24T17:30:00.000Z'); // CET = UTC+1
  const ld = `<script type="application/ld+json">{"@type":"Product","offers":{"@type":"Offer","price":"9800","priceCurrency":"CHF"}}</script>`;
  assert.strictEqual(parseAuctionHtml(ld).price, 9800);
  assert.strictEqual(parseDate('15.07.2026 10:00').toISOString(), '2026-07-15T08:00:00.000Z'); // CEST = UTC+2
});

test('parseNumber i slugify', () => {
  assert.strictEqual(parseNumber('120 000 km'), 120000);
  assert.strictEqual(parseNumber("CHF 12'500.50"), 12500.5);
  assert.strictEqual(parseNumber('45.900 PLN'), 45900);
  assert.strictEqual(slugify('Seria 3'), 'seria-3');
  assert.strictEqual(slugify('Mercedes-Benz'), 'mercedes-benz');
});

test('akcyza: 1999 cm³ → 4%, 2000 cm³ → 18%', () => {
  const costs = DEFAULT_SETTINGS.costs.filter((c) => c.id.startsWith('excise'));
  assert.strictEqual(calculateTotal(10000, { currency: 'PLN', engineCc: 1999, costs, rates }).totalPln, 10400);
  assert.strictEqual(calculateTotal(10000, { currency: 'PLN', engineCc: 2000, costs, rates }).totalPln, 11800);
});

test('transport w CH: km × 2 przejazdy × 2 CHF, liczony przed cłem i VAT', () => {
  const costs = [
    { name: 'Transport CH', type: 'distance', ratePerKm: 2, currency: 'CHF', trips: 2 },
    { name: 'VAT', type: 'percent', pct: 23, base: 'running' },
  ];
  const r = calculateTotal(10000, { currency: 'CHF', distanceKm: 100, costs, rates });
  // 100 km × 2 × 2 CHF = 400 CHF = 1800 PLN; (45000 + 1800) × 1.23 = 57564
  assert.strictEqual(r.items[0].amountPln, 1800);
  assert.strictEqual(r.totalPln, 57564);
  const missing = calculateTotal(10000, { currency: 'CHF', costs, rates });
  assert.strictEqual(missing.items[0].missing, true);
});

test('sekrety nie wracają do przeglądarki, maska nie nadpisuje hasła', () => {
  const { saveSettings, publicSettings, getSettings, MASK } = require('../src/settings');
  saveSettings({ auctionSite: { username: 'jan', password: 'tajne123' } });
  assert.strictEqual(publicSettings().auctionSite.password, MASK);
  saveSettings({ auctionSite: { username: 'jan', password: MASK } });
  assert.strictEqual(getSettings().auctionSite.password, 'tajne123');
});

test('logowanie formularzem i pobranie strony aukcji z sesją', async () => {
  const http = require('http');
  const { refreshAuction, resetSession } = require('../src/auctions');
  const server = http.createServer((req, res) => {
    const loggedIn = (req.headers.cookie || '').includes('sid=ok');
    if (req.url === '/login' && req.method === 'GET') {
      res.setHeader('Set-Cookie', 'pre=1; Path=/');
      return res.end('<form action="/do-login" method="post"><input type="hidden" name="csrf" value="xyz"><input name="email"><input type="password" name="pass"><button>Login</button></form>');
    }
    if (req.url === '/do-login') {
      let body = '';
      req.on('data', (c) => (body += c));
      return req.on('end', () => {
        const p = new URLSearchParams(body);
        if (p.get('email') === 'jan@x.ch' && p.get('pass') === 'pw' && p.get('csrf') === 'xyz' && req.headers.cookie.includes('pre=1')) {
          res.writeHead(302, { Location: '/konto', 'Set-Cookie': 'sid=ok; Path=/; HttpOnly' });
          return res.end();
        }
        res.end('<input type="password">');
      });
    }
    if (req.url === '/konto') return res.end('Witaj');
    if (req.url === '/auction/1') {
      if (!loggedIn) return res.end('<form><input name="email"><input type="password" name="pass"></form>');
      return res.end('<div class="bid">CHF 8\'900</div><div class="seller">Seestrasse 5, 8800 Thalwil</div>');
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    resetSession();
    const site = { loginUrl: `${base}/login`, username: 'jan@x.ch', password: 'pw', priceSelector: '.bid', sellerAddressSelector: '.seller' };
    const data = await refreshAuction({ url: `${base}/auction/1` }, site);
    assert.strictEqual(data.price, 8900);
    assert.strictEqual(data.sellerAddress, 'Seestrasse 5, 8800 Thalwil');
    resetSession();
    await assert.rejects(refreshAuction({ url: `${base}/auction/1` }, { ...site, password: 'zle' }), /Logowanie nieudane/);
  } finally {
    server.close();
  }
});
