// Parser strony szczegółów aukcji app.bestcarprice.ch – na podstawie widocznego tekstu strony
// (document.body.innerText). Dane wysyła skrót na iPhonie / zakładka w przeglądarce albo wklejony tekst.
const { parseNumber } = require('../http');
const { parseDate } = require('../auctions');

const FUEL = {
  diesel: 'diesel',
  benzin: 'benzyna',
  elektro: 'elektryczny',
  elektrisch: 'elektryczny',
  hybrid: 'hybryda',
  'plug-in': 'hybryda',
  gas: 'lpg',
};

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Wartość pola: "Etykieta<TAB/spacja/nowa linia>Wartość" */
function field(text, ...labels) {
  for (const label of labels) {
    const re = new RegExp(`(?:^|\\n)\\s*${escapeRe(label)}\\s*:?[\\t ]*(?:\\n\\s*)?([^\\n\\t]+)`, 'i');
    const m = text.match(re);
    if (m && m[1].trim()) return m[1].trim();
  }
  return null;
}

function parseSellerAddress(lines) {
  const i = lines.findIndex((l) => /^Vertragspartner|^Abholort/i.test(l));
  if (i < 0) return { seller: null, address: null };
  const block = lines
    .slice(i + 1, i + 8)
    .map((l) => l.trim())
    .filter((l) => l && !/garage folgen/i.test(l));
  const zipIdx = block.findIndex((l) => /^(CH-)?\d{4}\s+\S/.test(l));
  if (zipIdx < 0) return { seller: block[0] || null, address: null };
  const street = zipIdx >= 1 ? block[zipIdx - 1] : '';
  const seller = zipIdx >= 2 ? block[zipIdx - 2] : block[0];
  const address = [street, block[zipIdx], 'Schweiz'].filter(Boolean).join(', ');
  return { seller, address };
}

function parseNotes(lines) {
  // Opis stanu: od sekcji "Technisch" do danych sprzedawcy
  const start = lines.findIndex((l) => /^(Technisch|Karosserie|Schäden|Bereifung)$/i.test(l.trim()));
  const end = lines.findIndex((l) => /^Vertragspartner/i.test(l));
  if (start < 0) return '';
  return lines
    .slice(start, end > start ? end : start + 40)
    .map((l) => l.trim())
    .filter(Boolean)
    .join(' · ')
    .slice(0, 1500);
}

/**
 * @param {string} text  widoczny tekst strony (innerText)
 * @param {string} [url] adres strony aukcji
 * @returns {object} pola aukcji gotowe do zapisania
 */
function parseBestCarPriceText(text, url) {
  text = String(text || '').replace(/\r/g, '').replace(/ /g, ' ');
  const lines = text.split('\n');

  const make = field(text, 'Marke');
  const model = field(text, 'Modell');
  const firstReg = field(text, '1. Inverkehrssetzung', 'Inverkehrssetzung', 'Erstzulassung');
  const yearMatch = firstReg && firstReg.match(/(19|20)\d{2}/);
  const km = field(text, 'KM-Stand bei Übergabe', 'KM-Stand', 'Kilometerstand');
  const fuelRaw = (field(text, 'Treibstoff', 'Kraftstoff') || '').toLowerCase();
  const fuel = Object.entries(FUEL).find(([k]) => fuelRaw.includes(k))?.[1] || null;
  const cc = field(text, 'Hubraum', 'Hubraum in ccm', 'Hubraum (ccm)');
  const kw = field(text, 'Leistung in KW', 'Leistung (kW)');
  const endRaw = field(text, 'Inserat läuft bis', 'Auktion endet', 'Endet am');
  const endsAt = endRaw ? parseDate(endRaw) : null;
  const priceMatch = text.match(/(?:Aktuelles\s+)?Höchstgebot\s*:?\s*CHF\s*([\d'’.,\s]+)/i) || text.match(/Startpreis\s*:?\s*CHF\s*([\d'’.,\s]+)/i);
  const myBidMatch = text.match(/Mein\s+Gebot\s*:?\s*CHF\s*([\d'’.,\s]+)/i);
  const idMatch = text.match(/Inseratnummer\s*:?\s*([A-Za-z0-9-]+)/i);
  const { seller, address } = parseSellerAddress(lines);

  const out = {
    source: 'bestcarprice',
    externalId: idMatch ? idMatch[1] : null,
    url: url || null,
    make: make ? titleCase(make) : null,
    model: model || null,
    title: [make && titleCase(make), model].filter(Boolean).join(' ') || null,
    year: yearMatch ? Number(yearMatch[0]) : null,
    mileageKm: km ? parseNumber(km) : null,
    fuel,
    engineCc: cc ? parseNumber(cc) : null,
    powerKw: kw ? parseNumber(kw) : null,
    vin: field(text, 'Chassisnummer', 'VIN'),
    currency: 'CHF',
    currentPrice: priceMatch ? parseNumber(priceMatch[1]) : null,
    myBid: myBidMatch ? parseNumber(myBidMatch[1]) : null,
    endsAt: endsAt ? endsAt.toISOString() : null,
    sellerName: seller,
    sellerAddress: address,
    conditionNotes: parseNotes(lines),
  };
  for (const k of Object.keys(out)) if (out[k] == null || out[k] === '') delete out[k];
  return out;
}

function titleCase(s) {
  return s.toLowerCase().replace(/(^|[\s-])\p{L}/gu, (c) => c.toUpperCase());
}

/** "45 Minuten", "2 Stunden", "1 Tag 3 Std.", "01:12:30" → minuty do końca */
function parseTimeLeft(text) {
  const t = String(text || '');
  const hms = t.match(/\b(\d{1,2}):(\d{2}):(\d{2})\b/);
  if (hms) return Number(hms[1]) * 60 + Number(hms[2]) + Number(hms[3]) / 60;
  let min = 0;
  let found = false;
  const units = [
    [/(\d+)\s*(?:Tage?n?|Tg\.?|days?|d)\b/i, 1440],
    [/(\d+)\s*(?:Stunden?|Std\.?|hours?|h)\b/i, 60],
    [/(\d+)\s*(?:Minuten?|Min\.?|minutes?)\b/i, 1],
    [/(\d+)\s*(?:Sekunden?|Sek\.?|seconds?|s)\b/i, 1 / 60],
  ];
  for (const [re, mult] of units) {
    const m = t.match(re);
    if (m) {
      min += Number(m[1]) * mult;
      found = true;
    }
  }
  return found ? min : null;
}

/** Kafelek z listy „Aktuelle”: tytuł, rocznik, przebieg, najwyższa oferta, czas do końca. */
function parseListCard(text) {
  const lines = String(text || '')
    .replace(/ /g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const joined = lines.join('\n');
  const kmLine = lines.find((l) => /\d\s*km\b/i.test(l));
  const km = kmLine && kmLine.match(/(\d[\d'’. ]{0,9})\s*km\b/i);
  const reg = joined.match(/\b(\d{2})\.((?:19|20)\d{2})\b/);
  const bid = joined.match(/Höchstgebot\s*:?\s*CHF\s*([\d'’.,]+)/i);
  const anyChf = joined.match(/CHF\s*([\d'’.,]+)/i);
  const timeLine = lines.find((l) => parseTimeLeft(l) != null && !/km|CHF/i.test(l));
  const skip = /CHF|Gebot|km\b|^\d|Minute|Stunde|Tag|Sekunde|^Automat|^Manuell|^Schalt|^Halbautomat/i;
  const title = lines.find((l) => !skip.test(l) && /[A-Za-zÄÖÜ]{2}/.test(l) && l.length >= 3) || null;
  return {
    title,
    year: reg ? Number(reg[2]) : null,
    mileageKm: km ? parseNumber(km[1]) : null,
    currentPrice: bid ? parseNumber(bid[1]) : null,
    anyPrice: anyChf ? parseNumber(anyChf[1]) : null,
    minutesLeft: timeLine ? parseTimeLeft(timeLine) : null,
  };
}

module.exports = { parseBestCarPriceText, parseListCard, parseTimeLeft };
