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
    if (data.price != null) auction.currentPrice = data.price;
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
      costs: settings.costs,
      rates: fx,
      marketValuePln: auction.marketValueOverridePln || auction.market?.valuePln,
      thresholdPct: settings.thresholdPct,
    }),
    rate: fx[(auction.currency || 'CHF').toUpperCase()],
    at: new Date().toISOString(),
  };
  return auction;
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
    `Cena teraz: ${fmt(auction.currentPrice)} ${cur} (≈ ${fmt(e.pricePln)} PLN)`,
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

let running = false;

async function tick() {
  if (running) return;
  running = true;
  try {
    const settings = getSettings();
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
      if (sinceFetch >= (nearCheck ? 1 : Number(settings.auctionSite.refreshMinutes || 10))) {
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

module.exports = { start, tick, evaluate, ensureDistance, updateMarket, updatePrice, dealMessage, minutesLeft, sendDeal };
