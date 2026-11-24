// Pobieranie ogłoszeń z OLX.pl (publiczne API JSON używane przez stronę OLX).
const { getJson, parseNumber } = require('../http');

const CATEGORY_CARS = 84; // Motoryzacja > Samochody osobowe
const FUEL = { benzyna: 'petrol', petrol: 'petrol', diesel: 'diesel', lpg: 'lpg', hybryda: 'hybrid', hybrid: 'hybrid', elektryczny: 'electric', electric: 'electric' };

function buildApiUrl(car, { yearTolerance = 1, mileageTolerancePct = 35 } = {}, offset = 0) {
  const q = new URLSearchParams();
  q.set('offset', String(offset));
  q.set('limit', '50');
  q.set('category_id', String(CATEGORY_CARS));
  q.set('query', car.olxQuery || [car.make, car.model].filter(Boolean).join(' '));
  if (car.year) {
    q.set('filter_float_year:from', String(Number(car.year) - yearTolerance));
    q.set('filter_float_year:to', String(Number(car.year) + yearTolerance));
  }
  if (car.mileageKm) {
    const m = Number(car.mileageKm);
    // OLX używa literówki "milage" w nazwie parametru
    q.set('filter_float_milage:from', String(Math.max(0, Math.round(m * (1 - mileageTolerancePct / 100)))));
    q.set('filter_float_milage:to', String(Math.round(m * (1 + mileageTolerancePct / 100))));
  }
  const fuel = FUEL[String(car.fuel || '').toLowerCase()];
  if (fuel) q.set('filter_enum_petrol[0]', fuel);
  return `https://www.olx.pl/api/v1/offers/?${q.toString()}`;
}

function param(offer, key) {
  return (offer.params || []).find((p) => p.key === key)?.value;
}

function parseOlxResponse(json) {
  const out = [];
  for (const offer of json?.data || []) {
    const priceVal = param(offer, 'price');
    const price = parseNumber(priceVal?.value);
    if (!price) continue;
    const year = param(offer, 'year');
    const mileage = param(offer, 'milage') || param(offer, 'mileage');
    out.push({
      source: 'olx',
      id: String(offer.id),
      title: offer.title || '',
      url: offer.url || null,
      price,
      currency: priceVal?.currency || 'PLN',
      year: parseNumber(year?.key ?? year?.label),
      mileageKm: parseNumber(mileage?.key ?? mileage?.label),
    });
  }
  return out;
}

async function search(car, marketSettings) {
  const url = buildApiUrl(car, marketSettings);
  const json = await getJson(url, { headers: { Accept: 'application/json' } });
  const webUrl = `https://www.olx.pl/motoryzacja/samochody/q-${encodeURIComponent(
    (car.olxQuery || [car.make, car.model].join(' ')).trim().replace(/\s+/g, '-')
  )}/`;
  return { searchUrl: webUrl, listings: parseOlxResponse(json) };
}

module.exports = { search, buildApiUrl, parseOlxResponse };
