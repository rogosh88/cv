// Serwer HTTP: API + aplikacja PWA (frontend w /public).
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const store = require('./store');
const { getSettings, saveSettings } = require('./settings');
const { rates } = require('./fx');
const { evaluateDeal } = require('./costs');
const monitor = require('./monitor');
const { notify, getVapid } = require('./notify');

const app = express();
app.use(express.json({ limit: '1mb' }));

// ---- Prosta ochrona hasłem (ustaw APP_PASSWORD w zmiennych środowiskowych) ----
const PASSWORD = process.env.APP_PASSWORD || '';
function auth(req, res, next) {
  if (!PASSWORD) return next();
  const given = String(req.get('x-app-password') || '');
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(PASSWORD).digest();
  if (crypto.timingSafeEqual(a, b)) return next();
  res.status(401).json({ error: 'Nieprawidłowe hasło' });
}

app.get('/api/health', (req, res) => res.json({ ok: true, passwordRequired: !!PASSWORD }));
app.use('/api', auth);

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((err) => {
    console.error(err);
    res.status(400).json({ error: err.message });
  });

// ---- Ustawienia ----
app.get('/api/settings', (req, res) => res.json(getSettings()));
app.put('/api/settings', (req, res) => res.json(saveSettings(req.body)));

app.get('/api/fx', wrap(async (req, res) => res.json(await rates())));

// ---- Kalkulator (do sprawdzenia formuły kosztów) ----
app.post(
  '/api/calc',
  wrap(async (req, res) => {
    const s = getSettings();
    const { price, currency = 'CHF', engineCc, marketValuePln } = req.body;
    res.json(
      evaluateDeal({ price, currency, engineCc, costs: s.costs, rates: await rates(), marketValuePln: Number(marketValuePln) || null, thresholdPct: s.thresholdPct })
    );
  })
);

// ---- Aukcje ----
const EDITABLE = ['title', 'make', 'model', 'year', 'mileageKm', 'fuel', 'engineCc', 'url', 'currency', 'currentPrice', 'endsAt', 'notes', 'otomotoUrl', 'olxQuery', 'fbQuery', 'manualPrices', 'marketValueOverridePln', 'autoRefresh', 'status'];
const NUMERIC = ['year', 'mileageKm', 'engineCc', 'currentPrice', 'marketValueOverridePln'];

function sanitize(body) {
  const out = {};
  for (const k of EDITABLE) {
    if (body[k] === undefined) continue;
    let v = body[k];
    if (NUMERIC.includes(k)) v = v === '' || v == null ? null : Number(v);
    if (k === 'endsAt' && v) {
      const d = new Date(v);
      if (isNaN(d)) throw new Error('Nieprawidłowa data zakończenia');
      v = d.toISOString();
    }
    if (k === 'manualPrices') {
      v = (Array.isArray(v) ? v : String(v || '').split(/[\s;,]+/))
        .map((x) => Number(String(x).replace(/[^\d.]/g, '')))
        .filter((x) => x > 0);
    }
    out[k] = v;
  }
  return out;
}

app.get('/api/auctions', (req, res) => {
  const list = store.listAuctions().sort((a, b) => new Date(a.endsAt || 0) - new Date(b.endsAt || 0));
  res.json(list);
});

app.post(
  '/api/auctions',
  wrap(async (req, res) => {
    const data = sanitize(req.body);
    if (!data.make && !data.title) throw new Error('Podaj markę (i model) auta');
    if (!data.endsAt) throw new Error('Podaj datę i godzinę zakończenia aukcji');
    const auction = { id: store.id(), currency: 'CHF', status: 'active', createdAt: new Date().toISOString(), ...data };
    await monitor.evaluate(auction, getSettings());
    store.upsertAuction(auction);
    res.json(auction);
  })
);

app.post(
  '/api/import',
  wrap(async (req, res) => {
    const items = Array.isArray(req.body) ? req.body : [req.body];
    const created = [];
    for (const item of items) {
      const data = sanitize(item);
      const existing = data.url && store.listAuctions().find((a) => a.url === data.url);
      const auction = existing ? { ...existing, ...data } : { id: store.id(), currency: 'CHF', status: 'active', createdAt: new Date().toISOString(), ...data };
      await monitor.evaluate(auction, getSettings());
      store.upsertAuction(auction);
      created.push(auction);
    }
    res.json(created);
  })
);

app.put(
  '/api/auctions/:id',
  wrap(async (req, res) => {
    const current = store.getAuction(req.params.id);
    if (!current) return res.status(404).json({ error: 'Nie znaleziono' });
    const data = sanitize(req.body);
    const auction = { ...current, ...data };
    const settings = getSettings();
    // Zmiana auta → wycena rynkowa do odświeżenia
    if (['make', 'model', 'year', 'mileageKm', 'fuel', 'otomotoUrl', 'olxQuery', 'manualPrices'].some((k) => k in data && JSON.stringify(data[k]) !== JSON.stringify(current[k]))) {
      auction.market = null;
    }
    // Aukcja przedłużona → ponowne sprawdzenie przed nowym końcem
    if (data.endsAt && data.endsAt !== current.endsAt && monitor.minutesLeft(auction) > settings.checkMinutesBeforeEnd) {
      auction.checkDoneAt = null;
      auction.reminderDoneAt = null;
      if (auction.status === 'ended') auction.status = 'active';
    }
    await monitor.evaluate(auction, settings);
    store.upsertAuction(auction);
    res.json(auction);
  })
);

app.delete('/api/auctions/:id', (req, res) => {
  store.deleteAuction(req.params.id);
  res.json({ ok: true });
});

// Ręczne odświeżenie: cena ze strony aukcji + wycena rynkowa + ocena
app.post(
  '/api/auctions/:id/refresh',
  wrap(async (req, res) => {
    const auction = store.getAuction(req.params.id);
    if (!auction) return res.status(404).json({ error: 'Nie znaleziono' });
    const settings = getSettings();
    await monitor.updatePrice(auction, settings);
    if (req.body?.market !== false) await monitor.updateMarket(auction, settings);
    await monitor.evaluate(auction, settings);
    store.upsertAuction(auction);
    res.json(auction);
  })
);

app.get('/api/alerts', (req, res) => res.json(store.listAlerts()));

// ---- Powiadomienia ----
app.get('/api/push/key', (req, res) => res.json({ publicKey: getVapid().publicKey }));
app.post('/api/push/subscribe', (req, res) => {
  if (!req.body?.endpoint) return res.status(400).json({ error: 'Brak subskrypcji' });
  store.addSubscription(req.body);
  res.json({ ok: true });
});
app.post('/api/push/unsubscribe', (req, res) => {
  store.removeSubscription(req.body?.endpoint);
  res.json({ ok: true });
});
app.post(
  '/api/notify/test',
  wrap(async (req, res) => {
    res.json(await notify({ title: '✅ Test powiadomień', body: 'Monitor aukcji działa – tak będą wyglądać alerty o okazjach.', appUrl: '/' }));
  })
);

// ---- Frontend ----
app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));

const PORT = Number(process.env.PORT) || 3000;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Monitor aukcji działa na http://localhost:${PORT}`);
    if (!PASSWORD) console.warn('UWAGA: brak APP_PASSWORD – aplikacja nie jest chroniona hasłem.');
    monitor.start();
  });
}

module.exports = app;
