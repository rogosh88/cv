// Odświeżanie danych aukcji (aktualna cena, czas zakończenia) ze strony aukcyjnej.
// Adapter ogólny: JSON-LD / meta tagi / selektory CSS z ustawień. Gdy strona wymaga logowania,
// w ustawieniach można podać ciasteczko sesji. Gdy pobieranie się nie uda – cenę można aktualizować ręcznie.
const cheerio = require('cheerio');
const { parseNumber, UA } = require('./http');
const store = require('./store');

// ---------- Zabezpieczenia przed zablokowaniem konta ----------
const MIN_LOGIN_INTERVAL_MS = 30 * 60 * 1000; // nie częściej niż 1 logowanie na 30 min
const FAILED_LOGIN_PAUSE_MS = 6 * 60 * 60 * 1000; // po nieudanym logowaniu: pauza 6 h (bez ponawiania)
const MIN_REQUEST_GAP_MS = 4000; // minimum 4 s między zapytaniami do strony aukcji

// ---------- Sesja logowania (ciasteczka zapisywane na dysku – restart serwera nie wymaga logowania) ----------
const saved = store.read('session', {});
const jar = new Map(Object.entries(saved.cookies || {}));
let loggedInAt = saved.loggedInAt || 0;
let lastLoginAttemptAt = saved.lastLoginAttemptAt || 0;
let blockedUntil = saved.blockedUntil || 0;
let blockReason = saved.blockReason || '';
let lastRequestAt = 0;

function persist() {
  store.write('session', { cookies: Object.fromEntries(jar), loggedInAt, lastLoginAttemptAt, blockedUntil, blockReason });
}

async function throttle() {
  const wait = MIN_REQUEST_GAP_MS + Math.random() * 2000 - (Date.now() - lastRequestAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();
}

function sessionStatus() {
  return {
    loggedIn: !!loggedInAt,
    loggedInAt: loggedInAt ? new Date(loggedInAt).toISOString() : null,
    lastLoginAttemptAt: lastLoginAttemptAt ? new Date(lastLoginAttemptAt).toISOString() : null,
    blockedUntil: blockedUntil > Date.now() ? new Date(blockedUntil).toISOString() : null,
    blockReason: blockedUntil > Date.now() ? blockReason : '',
  };
}

function storeCookies(res) {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const c of list) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
}
function cookieHeader(extra) {
  const parts = [...jar].map(([k, v]) => `${k}=${v}`);
  if (extra) parts.push(extra);
  return parts.join('; ');
}

/** Pobranie z ręcznym śledzeniem przekierowań, żeby zachować ciasteczka z każdego kroku. */
async function request(url, { method = 'GET', body, headers = {}, cookie } = {}) {
  for (let i = 0; i < 8; i++) {
    await throttle();
    const res = await fetch(url, {
      method,
      body,
      redirect: 'manual',
      headers: { 'User-Agent': UA, 'Accept-Language': 'de-CH,de;q=0.9,pl;q=0.8', Cookie: cookieHeader(cookie), ...headers },
      signal: AbortSignal.timeout(20000),
    });
    storeCookies(res);
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) {
      url = new URL(loc, url).toString();
      method = 'GET';
      body = undefined;
      delete headers['Content-Type'];
      continue;
    }
    persist();
    return { res, url, text: await res.text() };
  }
  throw new Error('Za dużo przekierowań');
}

/** Znajduje formularz logowania (z polem hasła) i wypełnia go danymi. */
function buildLoginForm(html, pageUrl, username, password) {
  const $ = cheerio.load(html);
  const pw = $('input[type="password"]').first();
  if (!pw.length) throw new Error('Na stronie logowania nie znaleziono pola hasła');
  const form = pw.closest('form');
  const fields = new URLSearchParams();
  const scope = form.length ? form : $('body');
  scope.find('input').each((_, el) => {
    const name = $(el).attr('name');
    const type = ($(el).attr('type') || 'text').toLowerCase();
    if (!name || ['submit', 'button', 'image', 'file'].includes(type)) return;
    if (type === 'checkbox' && $(el).attr('checked') == null) return;
    fields.set(name, $(el).attr('value') || '');
  });
  const userInput =
    scope.find('input[type="email"]').first().attr('name') ||
    scope.find('input').filter((_, el) => /user|mail|login|benutzer|name/i.test($(el).attr('name') || '') && ($(el).attr('type') || 'text') !== 'hidden' && $(el).attr('type') !== 'password').first().attr('name') ||
    scope.find('input[type="text"], input:not([type])').first().attr('name');
  if (!userInput) throw new Error('Na stronie logowania nie znaleziono pola loginu');
  fields.set(userInput, username);
  fields.set(pw.attr('name'), password);
  const action = new URL(form.attr('action') || pageUrl, pageUrl).toString();
  return { action, method: (form.attr('method') || 'POST').toUpperCase(), body: fields.toString() };
}

function block(reason) {
  blockedUntil = Date.now() + FAILED_LOGIN_PAUSE_MS;
  blockReason = reason;
  loggedInAt = 0;
  persist();
  // powiadom raz – żeby było wiadomo, że monitor nie pobiera cen
  require('./notify')
    .notify({ title: '⚠️ Monitor aukcji: problem z logowaniem', body: `${reason}\nAutomatyczne logowanie wstrzymane na 6 h. Sprawdź dane w ustawieniach.` })
    .catch(() => {});
}

/**
 * Logowanie z zabezpieczeniami: maks. 1 próba na 30 min, a po nieudanej – pauza 6 h.
 * force = true tylko dla ręcznego „Sprawdź logowanie”.
 */
async function login(site, { force = false } = {}) {
  if (!site.loginUrl || !site.username || !site.password) throw new Error('Brak danych logowania (adres logowania, login, hasło)');
  if (!force) {
    if (blockedUntil > Date.now()) throw new Error(`Logowanie wstrzymane do ${new Date(blockedUntil).toLocaleString('pl-PL')}: ${blockReason}`);
    if (Date.now() - lastLoginAttemptAt < MIN_LOGIN_INTERVAL_MS) throw new Error('Sesja wygasła, a ostatnie logowanie było mniej niż 30 min temu – czekam, żeby nie zablokować konta');
  }
  lastLoginAttemptAt = Date.now();
  jar.clear();
  try {
    const page = await request(site.loginUrl);
    const form = buildLoginForm(page.text, page.url, site.username, site.password);
    const after = await request(form.action, {
      method: form.method,
      body: form.body,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: page.url },
    });
    if (after.res.status === 429 || after.res.status === 403) throw new Error(`Strona odrzuciła logowanie (HTTP ${after.res.status})`);
    if (looksLikeLoginPage(after.text)) throw new Error('Logowanie nieudane – sprawdź login i hasło');
  } catch (err) {
    block(err.message);
    throw err;
  }
  loggedInAt = Date.now();
  blockedUntil = 0;
  blockReason = '';
  persist();
  return true;
}

function looksLikeLoginPage(html) {
  return /<input[^>]+type=["']?password/i.test(html);
}

/** Pobiera stronę aukcji; w razie potrzeby loguje się (i ponawia raz). */
async function fetchAuctionPage(url, site) {
  const canLogin = site.loginUrl && site.username && site.password;
  if (canLogin && !loggedInAt) await login(site);
  let page = await request(url, { cookie: site.cookie });
  if (page.res.status === 429) throw new Error('Strona aukcji ogranicza liczbę zapytań (HTTP 429) – zwiększ odstęp odświeżania');
  if (!page.res.ok) throw new Error(`HTTP ${page.res.status} ze strony aukcji`);
  if (canLogin && looksLikeLoginPage(page.text)) {
    await login(site);
    page = await request(url, { cookie: site.cookie });
  }
  return page.text;
}

function findInJsonLd($) {
  let price = null;
  let endsAt = null;
  let currency = null;
  let sellerAddress = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const walk = (v) => {
        if (!v || typeof v !== 'object') return;
        if (Array.isArray(v)) return v.forEach(walk);
        const offers = v.offers || (v['@type'] === 'Offer' || v['@type'] === 'AggregateOffer' ? v : null);
        if (offers) {
          const o = Array.isArray(offers) ? offers[0] : offers;
          price = price ?? parseNumber(o.price ?? o.highPrice ?? o.lowPrice);
          currency = currency ?? o.priceCurrency;
          endsAt = endsAt ?? o.priceValidUntil ?? o.availabilityEnds ?? null;
        }
        endsAt = endsAt ?? v.endDate ?? null;
        const addr = v.address || v.seller?.address || v.offeredBy?.address;
        if (!sellerAddress && addr && typeof addr === 'object') {
          sellerAddress = [addr.streetAddress, [addr.postalCode, addr.addressLocality].filter(Boolean).join(' '), addr.addressCountry?.name || addr.addressCountry]
            .filter((x) => x && typeof x === 'string')
            .join(', ') || null;
        }
        Object.values(v).forEach(walk);
      };
      walk(JSON.parse($(el).html()));
    } catch {}
  });
  return { price, endsAt, currency, sellerAddress };
}

function parseAuctionHtml(html, siteSettings = {}) {
  const $ = cheerio.load(html);
  const result = { price: null, endsAt: null, currency: null, sellerAddress: null };

  if (siteSettings.sellerAddressSelector) {
    const t = $(siteSettings.sellerAddressSelector).first().text().replace(/\s+/g, ' ').trim();
    if (t) result.sellerAddress = t;
  }

  if (siteSettings.priceSelector) {
    const el = $(siteSettings.priceSelector).first();
    result.price = parseNumber(el.attr('content') || el.attr('data-price') || el.text());
  }
  if (siteSettings.endTimeSelector) {
    const el = $(siteSettings.endTimeSelector).first();
    const raw = el.attr('datetime') || el.attr('data-end') || el.attr('data-endtime') || el.attr('content') || el.text();
    const d = parseDate(raw);
    if (d) result.endsAt = d.toISOString();
  }

  const ld = findInJsonLd($);
  result.price = result.price ?? ld.price;
  result.currency = ld.currency;
  result.sellerAddress = result.sellerAddress ?? ld.sellerAddress;
  if (!result.endsAt && ld.endsAt) {
    const d = parseDate(ld.endsAt);
    if (d) result.endsAt = d.toISOString();
  }
  if (result.price == null) {
    const meta = $('meta[itemprop="price"], meta[property="product:price:amount"], [itemprop="price"]').first();
    result.price = parseNumber(meta.attr('content') || meta.text());
  }
  return result;
}

/** Obsługuje ISO, timestamp (s/ms) oraz format szwajcarski "24.11.2026 18:30" */
function parseDate(raw) {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim();
  if (/^\d{10,13}$/.test(s)) return new Date(Number(s) * (s.length === 10 ? 1000 : 1));
  const ch = s.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})[\s,\-–]+(?:um\s+)?(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (ch) {
    // Czas szwajcarski (Europe/Zurich) – ta sama strefa co Polska
    const [, d, m, y, hh, mm, ss] = ch;
    return zurichToDate(+y, +m, +d, +hh, +mm, +(ss || 0));
  }
  const d = new Date(s);
  return isNaN(d) ? null : d;
}

function zurichToDate(y, m, d, hh, mm, ss) {
  const guess = new Date(Date.UTC(y, m - 1, d, hh, mm, ss));
  const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Zurich', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const parts = Object.fromEntries(fmt.formatToParts(guess).map((p) => [p.type, p.value]));
  const asZurich = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second);
  return new Date(guess.getTime() - (asZurich - guess.getTime()));
}

async function refreshAuction(auction, siteSettings) {
  if (!auction.url) throw new Error('Brak adresu URL aukcji');
  const html = await fetchAuctionPage(auction.url, siteSettings);
  const data = parseAuctionHtml(html, siteSettings);
  if (data.price == null) throw new Error('Nie znaleziono ceny na stronie aukcji (ustaw selektor CSS w ustawieniach)');
  return data;
}

function resetSession() {
  jar.clear();
  loggedInAt = 0;
  lastLoginAttemptAt = 0;
  blockedUntil = 0;
  blockReason = '';
  persist();
}

module.exports = { refreshAuction, resetSession, sessionStatus, parseAuctionHtml, parseDate, login, buildLoginForm, looksLikeLoginPage };
