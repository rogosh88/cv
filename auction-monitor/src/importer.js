// Zapis aukcji rozpoznanych ze strony bestcarprice (skrót, zakładka, wklejony tekst, automatyczny skan listy).
const store = require('./store');
const { getSettings } = require('./settings');
const { parseBestCarPriceText } = require('./sites/bestcarprice');

/** Klucz do dopasowania kafelka z listy do aukcji: tytuł + przebieg, np. "mercedesbenze220d|114421" */
function listKey(title, mileageKm) {
  const t = String(title || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return t ? `${t}|${Math.round(Number(mileageKm) || 0)}` : null;
}

function auctionListKey(a) {
  return a.listKey || listKey(a.title || [a.make, a.model].filter(Boolean).join(' '), a.mileageKm);
}

/** Tworzy lub aktualizuje aukcję z rozpoznanych pól. Dopasowanie: numer ogłoszenia, URL, klucz z listy. */
async function importParsed(parsed, { extra = {} } = {}) {
  const monitor = require('./monitor');
  const list = store.listAuctions();
  const key = extra.listKey || listKey(parsed.title, parsed.mileageKm);
  const existing = list.find(
    (a) => (parsed.externalId && a.externalId === parsed.externalId) || (parsed.url && a.url === parsed.url) || (key && auctionListKey(a) === key)
  );
  const now = new Date().toISOString();
  let auction;
  if (existing) {
    auction = { ...existing };
    // Dane ze strony aktualizujemy, ale nie nadpisujemy pól uzupełnionych ręcznie (pojemność, koszt naprawy…)
    for (const [k, v] of Object.entries(parsed)) {
      if (['currentPrice', 'endsAt', 'myBid', 'conditionNotes', 'url'].includes(k) || existing[k] == null || existing[k] === '') auction[k] = v;
    }
    if (parsed.currentPrice != null && parsed.currentPrice !== existing.currentPrice) auction.priceUpdatedAt = now;
    if (parsed.endsAt && parsed.endsAt !== existing.endsAt && monitor.minutesLeft(auction) > getSettings().checkMinutesBeforeEnd) {
      auction.checkDoneAt = null;
      auction.reminderDoneAt = null;
      auction.status = 'active';
    }
  } else {
    if (!parsed.endsAt) throw new Error('Nie znaleziono daty zakończenia aukcji („Inserat läuft bis”)');
    auction = { id: store.id(), status: 'active', createdAt: now, priceUpdatedAt: now, autoRefresh: true, ...parsed };
  }
  Object.assign(auction, extra);
  if (key) auction.listKey = key;
  auction.lastImportAt = now;
  await monitor.evaluate(auction, getSettings());
  store.upsertAuction(auction);
  return { created: !existing, auction };
}

/** Import z tekstu strony (skrót iPhone wysyła "adres\ntekst strony"). */
async function importText({ text, url }) {
  if (!text || String(text).length < 30) throw new Error('Brak tekstu strony');
  const firstLine = String(text).split('\n', 1)[0].trim();
  if (!url && /^https?:\/\/\S+$/.test(firstLine)) {
    url = firstLine;
    text = String(text).slice(firstLine.length + 1);
  }
  const parsed = parseBestCarPriceText(text, url);
  if (!parsed.make && !parsed.currentPrice) throw new Error('Nie rozpoznano danych aukcji – otwórz stronę szczegółów aukcji (Detail)');
  return importParsed(parsed);
}

module.exports = { importText, importParsed, listKey, auctionListKey };
