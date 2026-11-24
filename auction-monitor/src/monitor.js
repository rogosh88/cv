// Harmonogram: co minutę sprawdza aukcje; X minut przed końcem porównuje koszt z rynkiem i wysyła powiadomienie.
const store = require('./store');
const { getSettings } = require('./settings');
const { rates } = require('./fx');
const { evaluateDeal } = require('./costs');
const market = require('./market');
const { refreshAuction } = require('./auctions');
const { notify } = require('./notify');
const { drivingDistanceKm } = require('./geo');

const MIN = 60 * 1000;
const fmt = (n) => (n == null ? '—' : Math.round(n).toLocaleString('pl-PL'));

function minutesLeft(auction, now = Date.now()) {
  return auction.endsAt ? (new Date(auction.endsAt).getTime() - now) / MIN : null;
}

function marketStale(auction, settings) {
  if (!auction.market?.fetchedAt) return true;
  return Date.now() - new Date(auction.market.fetchedAt).getTime() > settings.market.cacheHours * 60 * MIN;
}

async function updateMarket(auction, settings) {
  auction.market = await market.lookup(auction, settings.market);
  return auction;
}

async function updatePrice(auction, settings) {
  if (!auction.url || auction.autoRefresh === false) return auction;
  try {
    const data = await refreshAuction(auction, settings.auctionSite);
    if (data.price != null) {
      if (data.price !== auction.currentPrice) auction.priceUpdatedAt = new Date().toISOString();
      auction.currentPrice = data.price;
    }
    if (data.endsAt) auction.endsAt = data.endsAt;
    if (data.currency) auction.currency = data.currency.toUpperCase();
    if (data.sellerAddress && !auction.sellerAddress) auction.sellerAddress = data.sellerAddress;
    auction.lastFetchAt = new Date().toISOString();
    auction.lastFetchError = null;
  } catch (err) {
    auction.lastFetchAt = new Date().toISOString();
    auction.lastFetchError = err.message;
  }
  return auction;
}

/** Liczy odległość garaż → sprzedający (raz na parę adresów; wynik zapisany przy aukcji). */
async function ensureDistance(auction, settings) {
  const from = (settings.garageAddress || '').trim();
  const to = (auction.sellerAddress || '').trim();
  if (!from || !to || auction.distanceKmOverride) return auction;
  if (auction.route && auction.route.from === from && auction.route.to === to && (auction.route.km || auction.route.manual)) return auction;
  try {
    const { km, method } = await drivingDistanceKm(from, to);
    auction.route = { from, to, km, method, at: new Date().toISOString() };
  } catch (err) {
    auction.route = { from, to, km: null, error: err.message, at: new Date().toISOString() };
  }
  return auction;
}

async function evaluate(auction, settings) {
  await ensureDistance(auction, settings);
  const fx = await rates();
  auction.evaluation = {
    ...evaluateDeal({
      price: auction.currentPrice,
      currency: auction.currency || 'CHF',
      engineCc: auction.engineCc,
      distanceKm: auction.distanceKmOverride || auction.route?.km,
      costs: auction.repairCostPln > 0 ? [...settings.costs, { name: 'Naprawa (szacunek)', type: 'fixed', amount: auction.repairCostPln, currency: 'PLN' }] : settings.costs,
      rates: fx,
      marketValuePln: auction.marketValueOverridePln || auction.market?.valuePln,
      thresholdPct: settings.thresholdPct,
    }),
    rate: fx[(auction.currency || 'CHF').toUpperCase()],
    at: new Date().toISOString(),
  };
  return auction;
}

/** Informacja o wieku ceny, gdy nie jest świeża (np. aktualizowana ręcznie / skrótem) */
function priceAge(a) {
  const t = a.priceUpdatedAt || a.lastFetchAt || a.createdAt;
  if (!t) return '';
  const min = (Date.now() - new Date(t).getTime()) / MIN;
  if (min < 15) return '';
  const time = new Date(t).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Warsaw' });
  return ` – cena z ${time}, sprawdź aktualną!`;
}

function carLabel(a) {
  return a.title || [a.make, a.model, a.year].filter(Boolean).join(' ');
}

function dealMessage(auction, settings, kind) {
  const e = auction.evaluation;
  const left = minutesLeft(auction);
  const cur = auction.currency || 'CHF';
  const lines = [
    `${carLabel(auction)}${auction.mileageKm ? `, ${fmt(auction.mileageKm)} km` : ''}`,
    `Cena: ${fmt(auction.currentPrice)} ${cur} (≈ ${fmt(e.pricePln)} PLN)${priceAge(auction)}`,
    auction.repairCostPln ? `W tym naprawa: ${fmt(auction.repairCostPln)} PLN` : '',
    !(auction.engineCc > 0) ? 'Uwaga: pojemność nieznana – przyjęto wyższą akcyzę' : '',
    `Koszt w Polsce: ${fmt(e.totalPln)} PLN`,
    auction.sellerAddress ? `Sprzedający: ${auction.sellerAddress}${auction.route?.km ? ` (${fmt(auction.route.km)} km)` : ''}` : '',
    `Wartość rynkowa PL: ${fmt(e.marketValuePln)} PLN${auction.market?.stats?.count ? ` (${auction.market.stats.count} ogł.)` : ''}`,
    `Taniej o ${e.discountPct}% (próg ${settings.thresholdPct}%)`,
    `Maks. stawka dla progu: ${fmt(e.maxBid)} ${cur}`,
    left != null ? `Koniec za ${Math.max(0, Math.round(left))} min` : '',
  ].filter(Boolean);
  const title = kind === 'reminder' ? `⏰ Wciąż okazja – ${carLabel(auction)}` : `🚗 OKAZJA −${Math.round(e.discountPct)}% – ${carLabel(auction)}`;
  return { title, body: lines.join('\n'), url: auction.url };
}

async function sendDeal(auction, settings, kind) {
  const msg = dealMessage(auction, settings, kind);
  const report = await notify({ ...msg, appUrl: `/#auction-${auction.id}` });
  store.addAlert({ auctionId: auction.id, kind, title: msg.title, body: msg.body, url: auction.url, report });
}

/** Zapis tylko zmienionych pól – nie nadpisuje zmian wprowadzonych w międzyczasie przez użytkownika. */
function saveChanges(original, updated) {
  const fresh = store.getAuction(updated.id);
  if (!fresh) return; // usunięta w trakcie
  for (const key of new Set([...Object.keys(original), ...Object.keys(updated)])) {
    if (JSON.stringify(original[key]) !== JSON.stringify(updated[key])) fresh[key] = updated[key];
  }
  store.upsertAuction(fresh);
}

// ---------- Automatyczny skan listy aukcji (bestcarprice) ----------
function scanState() {
  return store.read('list-scan', {});
}

/** Przegląda listę aktywnych aukcji: aktualizuje ceny znanych aut i dodaje nowe kończące się w horyzoncie. */
async function discover(settings, { force = false } = {}) {
  const site = settings.auctionSite;
  if (!site.autoImport && !force) return null;
  if (!(site.loginUrl && site.username && site.password)) {
    if (force) throw new Error('Uzupełnij adres logowania, login i hasło w ustawieniach');
    return null;
  }
  const browser = require('./browser');
  const { login } = require('./auctions');
  const { parseListCard, parseBestCarPriceText } = require('./sites/bestcarprice');
  const { listKey, auctionListKey, importParsed } = require('./importer');

  const horizon = Number(site.horizonMinutes) || 180;
  const minYear = Number(site.minYear) || 0;
  const maxKm = Number(site.maxMileageKm) || 0;
  const passes = (c) =>
    c.minutesLeft != null && c.minutesLeft > 0 && c.minutesLeft <= horizon && (!minYear || !c.year || c.year >= minYear) && (!maxKm || !c.mileageKm || c.mileageKm <= maxKm);
  const known = () => new Map(store.listAuctions().map((a) => [auctionListKey(a), a]));
  const byKey = known();

  const state = { at: new Date().toISOString(), cards: 0, inHorizon: 0, imported: 0, updated: 0, errors: [] };
  try {
    const res = await browser.scanList(
      site,
      {
        listUrl: site.listUrl || 'https://app.bestcarprice.ch/?tab=active',
        horizonMin: horizon,
        maxDetails: Number(site.maxDetailsPerScan) || 8,
        parseCard: parseListCard,
        needsDetail: (c) => passes(c) && !byKey.get(listKey(c.title, c.mileageKm))?.url,
      },
      () => login(site)
    );
    const now = new Date().toISOString();
    state.cards = res.cards.length;

    // 1) Ceny znanych aut z samej listy (jedno wejście dla wszystkich)
    const current = known();
    for (const card of res.cards) {
      const c = parseListCard(card.text);
      if (passes(c)) state.inHorizon++;
      const a = current.get(listKey(c.title, c.mileageKm));
      if (!a || a.status !== 'active') continue;
      const fresh = store.getAuction(a.id);
      if (c.currentPrice != null && c.currentPrice !== fresh.currentPrice) {
        fresh.currentPrice = c.currentPrice;
        fresh.priceUpdatedAt = now;
      }
      fresh.lastListSeenAt = now;
      fresh.lastFetchError = null;
      await evaluate(fresh, settings);
      store.upsertAuction(fresh);
      state.updated++;
    }

    // 2) Nowe aukcje – dane ze stron szczegółów
    for (const d of res.details) {
      if (d.error) {
        state.errors.push(`Szczegóły: ${d.error}`);
        continue;
      }
      const card = parseListCard(d.cardText);
      const parsed = parseBestCarPriceText(d.text, d.url);
      if (!parsed.endsAt && card.minutesLeft != null) parsed.endsAt = new Date(Date.now() + card.minutesLeft * MIN).toISOString();
      if (parsed.currentPrice == null && card.currentPrice != null) parsed.currentPrice = card.currentPrice;
      if (!parsed.title && card.title) parsed.title = card.title;
      try {
        const r = await importParsed(parsed, { extra: { source: 'bestcarprice', listKey: listKey(card.title, card.mileageKm), lastListSeenAt: now } });
        if (r.created) state.imported++;
      } catch (err) {
        state.errors.push(`${card.title || 'aukcja'}: ${err.message}`);
      }
    }
    if (!res.cards.length) {
      state.errors.push('Na liście nie rozpoznano żadnych aukcji – zapisano podgląd strony (data/debug-list.json)');
      if (res.snapshot) store.write('debug-list', res.snapshot);
    }
  } catch (err) {
    state.errors.push(err.message);
  }
  state.errors = state.errors.slice(0, 6);
  store.write('list-scan', state);
  if (force && state.errors.length && !state.cards) throw new Error(state.errors[0]);
  return state;
}

function shouldScan(settings) {
  const site = settings.auctionSite;
  if (!site.autoImport || !(site.username && site.password)) return false;
  const checkMin = Number(settings.checkMinutesBeforeEnd);
  const nearAny = store
    .listAuctions()
    .some((a) => a.status === 'active' && a.source === 'bestcarprice' && !a.checkDoneAt && minutesLeft(a) != null && minutesLeft(a) <= checkMin + 3 && minutesLeft(a) > 0);
  const every = nearAny ? Number(site.nearEndRefreshMinutes || 2) : Number(site.listRefreshMinutes || 15);
  const last = scanState().at;
  return !last || (Date.now() - new Date(last).getTime()) / MIN >= every;
}

let running = false;

async function tick() {
  if (running) return;
  running = true;
  try {
    const settings = getSettings();
    if (shouldScan(settings)) await discover(settings);
    let marketLookupsLeft = 2; // ogranicz liczbę zapytań do portali na jeden cykl
    for (const original of store.listAuctions()) {
      if (original.status !== 'active') continue;
      const auction = JSON.parse(JSON.stringify(original));
      const left = minutesLeft(auction);
      if (left == null) continue;

      if (left < -5) {
        auction.status = 'ended';
        saveChanges(original, auction);
        continue;
      }

      const checkMin = Number(settings.checkMinutesBeforeEnd);
      const nearCheck = left <= checkMin + 3;
      const sinceFetch = auction.lastFetchAt ? (Date.now() - new Date(auction.lastFetchAt).getTime()) / MIN : Infinity;
      const every = nearCheck ? Number(settings.auctionSite.nearEndRefreshMinutes || 2) : Number(settings.auctionSite.refreshMinutes || 30);
      // Tuż przed porównaniem (T-20) zawsze świeża cena
      const mustFetch = !auction.checkDoneAt && left <= checkMin && sinceFetch >= 0.5;
      // Auta z bestcarprice odświeżane są z listy (jedno wejście dla wszystkich) – bez otwierania każdej aukcji
      const sinceList = auction.lastListSeenAt ? (Date.now() - new Date(auction.lastListSeenAt).getTime()) / MIN : Infinity;
      const freshFromList = settings.auctionSite.autoImport && sinceList < Math.max(every, 1);
      if (!freshFromList && (sinceFetch >= every || mustFetch)) {
        await updatePrice(auction, settings);
      }

      // Wycenę rynkową pobieramy z wyprzedzeniem (do 24 h przed końcem), żeby była gotowa na moment porównania
      if (left <= 24 * 60 && marketStale(auction, settings) && marketLookupsLeft > 0) {
        marketLookupsLeft--;
        try {
          await updateMarket(auction, settings);
        } catch (err) {
          console.warn('[market]', err.message);
        }
      }

      await evaluate(auction, settings);

      // Główne porównanie: X minut przed końcem
      if (!auction.checkDoneAt && left <= checkMin && left > 0) {
        auction.checkDoneAt = new Date().toISOString();
        auction.checkResult = { ...auction.evaluation, minutesLeft: Math.round(left) };
        if (auction.evaluation.isDeal) await sendDeal(auction, settings, 'deal');
      }

      // Przypomnienie tuż przed końcem, jeśli wciąż jest okazja
      const remMin = Number(settings.reminderMinutesBeforeEnd);
      if (remMin > 0 && auction.checkDoneAt && !auction.reminderDoneAt && left <= remMin && left > 0) {
        auction.reminderDoneAt = new Date().toISOString();
        if (auction.evaluation.isDeal) await sendDeal(auction, settings, 'reminder');
      }

      saveChanges(original, auction);
    }
  } catch (err) {
    console.error('[monitor]', err);
  } finally {
    running = false;
  }
}

function start() {
  setTimeout(tick, 3000);
  return setInterval(tick, MIN);
}

module.exports = { discover, scanState, start, tick, evaluate, ensureDistance, updateMarket, updatePrice, dealMessage, minutesLeft, sendDeal };
