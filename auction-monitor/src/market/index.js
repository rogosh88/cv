// Agregacja cen rynkowych z Otomoto, OLX i ręcznie dodanych cen (np. z Facebook Marketplace).
const otomoto = require('./otomoto');
const olx = require('./olx');
const { rates } = require('../fx');

const SOURCES = { otomoto, olx };

/** Link do wyszukiwania na Facebook Marketplace (do ręcznego sprawdzenia – FB wymaga logowania). */
function facebookSearchUrl(car, { yearTolerance = 1, mileageTolerancePct = 35 } = {}) {
  const q = new URLSearchParams();
  q.set('query', car.fbQuery || [car.make, car.model].filter(Boolean).join(' '));
  if (car.year) {
    q.set('minYear', String(Number(car.year) - yearTolerance));
    q.set('maxYear', String(Number(car.year) + yearTolerance));
  }
  if (car.mileageKm) q.set('maxMileage', String(Math.round(Number(car.mileageKm) * (1 + mileageTolerancePct / 100))));
  q.set('exact', 'false');
  return `https://www.facebook.com/marketplace/category/vehicles?${q.toString()}`;
}

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** Odrzuca wartości odstające metodą IQR (np. auta uszkodzone, błędne ceny). */
function removeOutliers(prices) {
  const s = [...prices].sort((a, b) => a - b);
  if (s.length < 4) return s;
  const q1 = quantile(s, 0.25);
  const q3 = quantile(s, 0.75);
  const iqr = q3 - q1;
  return s.filter((p) => p >= q1 - 1.5 * iqr && p <= q3 + 1.5 * iqr);
}

function isComparable(listing, car, { yearTolerance, mileageTolerancePct }) {
  if (car.year && listing.year && Math.abs(listing.year - Number(car.year)) > yearTolerance) return false;
  if (car.mileageKm && listing.mileageKm) {
    const m = Number(car.mileageKm);
    if (Math.abs(listing.mileageKm - m) > (m * mileageTolerancePct) / 100 + 5000) return false;
  }
  return listing.pricePln > 1000;
}

function computeStats(listings, marketSettings) {
  const cleaned = removeOutliers(listings.map((l) => l.pricePln));
  if (!cleaned.length) return { count: 0, median: null, p25: null, p75: null, min: null, max: null };
  return {
    count: cleaned.length,
    median: Math.round(quantile(cleaned, 0.5)),
    p25: Math.round(quantile(cleaned, 0.25)),
    p75: Math.round(quantile(cleaned, 0.75)),
    min: Math.round(cleaned[0]),
    max: Math.round(cleaned[cleaned.length - 1]),
  };
}

function marketValueFromStats(stats, marketSettings) {
  if (!stats.count || stats.count < (marketSettings.minListings || 1)) return null;
  const base = marketSettings.statistic === 'p25' ? stats.p25 : stats.median;
  return Math.round(base * (1 - (marketSettings.askingPriceDiscountPct || 0) / 100));
}

/**
 * Pobiera ogłoszenia ze wszystkich włączonych źródeł i wylicza wartość rynkową.
 * @returns {Promise<object>} market snapshot zapisywany przy aukcji
 */
async function lookup(car, marketSettings) {
  const fx = await rates();
  const sources = {};
  let listings = [];

  for (const [name, mod] of Object.entries(SOURCES)) {
    if (!marketSettings.sources?.[name]) continue;
    try {
      const { searchUrl, listings: found } = await mod.search(car, marketSettings);
      const normalized = found
        .map((l) => ({ ...l, pricePln: Math.round(l.price * (fx[(l.currency || 'PLN').toUpperCase()] || NaN)) }))
        .filter((l) => Number.isFinite(l.pricePln))
        .filter((l) => isComparable(l, car, marketSettings));
      sources[name] = { ok: true, searchUrl, found: found.length, used: normalized.length };
      listings = listings.concat(normalized);
    } catch (err) {
      sources[name] = { ok: false, error: err.message };
    }
  }

  // Ceny wpisane ręcznie (Facebook Marketplace lub inne)
  const manual = (car.manualPrices || []).map(Number).filter((p) => p > 0);
  if (manual.length) {
    sources.manual = { ok: true, found: manual.length, used: manual.length };
    listings = listings.concat(manual.map((p, i) => ({ source: 'ręcznie / Facebook', id: `m${i}`, title: 'Cena wpisana ręcznie', pricePln: p })));
  }
  sources.facebook = { ok: true, manualOnly: true, searchUrl: facebookSearchUrl(car, marketSettings) };

  const stats = computeStats(listings, marketSettings);
  return {
    fetchedAt: new Date().toISOString(),
    sources,
    stats,
    valuePln: marketValueFromStats(stats, marketSettings),
    // kilka najtańszych porównywalnych ogłoszeń do podglądu
    sample: [...listings].sort((a, b) => a.pricePln - b.pricePln).slice(0, 15),
  };
}

module.exports = { lookup, computeStats, removeOutliers, marketValueFromStats, isComparable, facebookSearchUrl, quantile };
