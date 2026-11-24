// Pobieranie ogłoszeń z Otomoto.pl (dane z osadzonego JSON-a __NEXT_DATA__ / JSON-LD).
const cheerio = require('cheerio');
const { getText, slugify, parseNumber } = require('../http');

const FUEL = {
  benzyna: 'petrol',
  petrol: 'petrol',
  diesel: 'diesel',
  hybryda: 'hybrid',
  hybrid: 'hybrid',
  'plug-in': 'plugin-hybrid',
  elektryczny: 'electric',
  electric: 'electric',
  lpg: 'petrol-lpg',
};

function buildSearchUrl(car, { yearTolerance = 1, mileageTolerancePct = 35 } = {}, page = 1) {
  const make = slugify(car.make);
  const model = slugify(car.model);
  let url = `https://www.otomoto.pl/osobowe/${make}${model ? '/' + model : ''}`;
  const q = new URLSearchParams();
  if (car.year) {
    q.set('search[filter_float_year:from]', String(Number(car.year) - yearTolerance));
    q.set('search[filter_float_year:to]', String(Number(car.year) + yearTolerance));
  }
  if (car.mileageKm) {
    const m = Number(car.mileageKm);
    q.set('search[filter_float_mileage:from]', String(Math.max(0, Math.round(m * (1 - mileageTolerancePct / 100)))));
    q.set('search[filter_float_mileage:to]', String(Math.round(m * (1 + mileageTolerancePct / 100))));
  }
  const fuel = FUEL[String(car.fuel || '').toLowerCase()];
  if (fuel) q.set('search[filter_enum_fuel_type]', fuel);
  q.set('search[filter_enum_damaged]', '0');
  q.set('search[order]', 'relevance_web');
  if (page > 1) q.set('page', String(page));
  return `${url}?${q.toString()}`;
}

function paramValue(params, keys) {
  if (!Array.isArray(params)) return null;
  for (const p of params) {
    if (keys.includes(p.key)) return parseNumber(p.value ?? p.displayValue);
  }
  return null;
}

function toListing(node) {
  const amount = node?.price?.amount;
  const price = parseNumber(amount?.units ?? amount?.value ?? node?.price?.value);
  if (!price) return null;
  return {
    source: 'otomoto',
    id: String(node.id ?? node.url),
    title: node.title || node.shortDescription || '',
    url: node.url || null,
    price,
    currency: amount?.currencyCode || node?.price?.currency || 'PLN',
    year: paramValue(node.parameters, ['year']),
    mileageKm: paramValue(node.parameters, ['mileage']),
  };
}

/** Rekurencyjnie przeszukuje strukturę danych w poszukiwaniu ogłoszeń (węzłów z ceną). */
function collectListings(root) {
  const out = new Map();
  const seen = new Set();
  const walk = (v, depth) => {
    if (depth > 40 || v == null) return;
    if (typeof v === 'string') {
      // urqlState trzyma odpowiedzi GraphQL jako zserializowany JSON
      if (v.length > 50 && v[0] === '{' && v.includes('price')) {
        try {
          walk(JSON.parse(v), depth + 1);
        } catch {}
      }
      return;
    }
    if (typeof v !== 'object' || seen.has(v)) return;
    seen.add(v);
    if (!Array.isArray(v) && v.price && typeof v.price === 'object' && (v.url || v.id) && v.title) {
      const l = toListing(v);
      if (l) out.set(l.id, l);
    }
    for (const child of Array.isArray(v) ? v : Object.values(v)) walk(child, depth + 1);
  };
  walk(root, 0);
  return [...out.values()];
}

function parseOtomotoHtml(html) {
  const $ = cheerio.load(html);
  let listings = [];
  const next = $('#__NEXT_DATA__').html();
  if (next) {
    try {
      listings = collectListings(JSON.parse(next));
    } catch {}
  }
  if (!listings.length) {
    // Fallback: JSON-LD
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const data = JSON.parse($(el).html());
        const items = [].concat(data?.itemListElement || data?.mainEntity?.itemListElement || []);
        for (const it of items) {
          const item = it.item || it;
          const offer = item.offers || {};
          const price = parseNumber(offer.price);
          if (price) {
            listings.push({
              source: 'otomoto',
              id: item.url || item.name,
              title: item.name || '',
              url: item.url || null,
              price,
              currency: offer.priceCurrency || 'PLN',
              year: parseNumber(item.vehicleModelDate || item.productionDate),
              mileageKm: parseNumber(item.mileageFromOdometer?.value),
            });
          }
        }
      } catch {}
    });
  }
  return listings;
}

async function search(car, marketSettings) {
  const urls = car.otomotoUrl
    ? [car.otomotoUrl]
    : [buildSearchUrl(car, marketSettings, 1), buildSearchUrl(car, marketSettings, 2)];
  const all = new Map();
  for (const url of urls) {
    const html = await getText(url);
    const found = parseOtomotoHtml(html);
    found.forEach((l) => all.set(l.id, l));
    if (found.length < 20) break; // brak kolejnej strony
  }
  return { searchUrl: urls[0], listings: [...all.values()] };
}

module.exports = { search, buildSearchUrl, parseOtomotoHtml, collectListings };
