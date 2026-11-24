// Wspólny klient HTTP dla scraperów.
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

async function getText(url, { headers = {}, timeoutMs = 20000 } = {}) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept-Language': 'pl-PL,pl;q=0.9,en;q=0.8',
      Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
      ...headers,
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} dla ${new URL(url).host}`);
  return res.text();
}

async function getJson(url, opts) {
  return JSON.parse(await getText(url, opts));
}

/** Usuwa polskie znaki, zamienia na slug: "Seria 3" -> "seria-3" */
function slugify(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ł/g, 'l')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** "120 000 km" -> 120000, "45 900 PLN" -> 45900 */
function parseNumber(v) {
  if (typeof v === 'number') return v;
  if (v == null) return null;
  const digits = String(v).replace(/[^\d.,]/g, '').replace(/[.,](?=\d{3}(\D|$))/g, '').replace(',', '.');
  const n = parseFloat(digits);
  return Number.isFinite(n) ? n : null;
}

module.exports = { getText, getJson, slugify, parseNumber, UA };
