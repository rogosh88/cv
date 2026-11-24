// Kursy walut z NBP (tabela A, średni kurs) z cache i fallbackiem do kursu ręcznego.
const { getSettings } = require('./settings');

const cache = {}; // { CHF: { rate, at } }
const TTL_MS = 6 * 60 * 60 * 1000;

async function fetchNbp(code) {
  const res = await fetch(`https://api.nbp.pl/api/exchangerates/rates/a/${code.toLowerCase()}/?format=json`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`NBP HTTP ${res.status}`);
  const json = await res.json();
  return json.rates[0].mid;
}

function manualRate(code, settings) {
  if (code === 'CHF') return Number(settings.manualChfPln);
  if (code === 'EUR') return Number(settings.manualEurPln);
  throw new Error(`Brak kursu dla ${code}`);
}

/** Zwraca kurs waluty -> PLN */
async function rateToPln(code) {
  code = (code || 'PLN').toUpperCase();
  if (code === 'PLN') return 1;
  const settings = getSettings();
  if (settings.fxMode !== 'nbp') return manualRate(code, settings);
  const c = cache[code];
  if (c && Date.now() - c.at < TTL_MS) return c.rate;
  try {
    const rate = await fetchNbp(code);
    cache[code] = { rate, at: Date.now() };
    return rate;
  } catch (err) {
    console.warn(`[fx] NBP niedostępne (${err.message}) – używam kursu ręcznego`);
    return c ? c.rate : manualRate(code, settings);
  }
}

async function rates() {
  return { CHF: await rateToPln('CHF'), EUR: await rateToPln('EUR'), PLN: 1 };
}

module.exports = { rateToPln, rates };
