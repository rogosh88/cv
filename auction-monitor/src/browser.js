// Ukryta przeglądarka (Chromium przez Playwright) dla stron-aplikacji, które budują formularz
// logowania i treść aukcji skryptami (np. app.bestcarprice.ch). Sesja (ciasteczka) zapisywana na dysku.
const fs = require('fs');
const path = require('path');
const store = require('./store');

const STATE_FILE = path.join(store.DATA_DIR, 'browser-state.json');
const IDLE_CLOSE_MS = 10 * 60 * 1000; // zamknij przeglądarkę po 10 min bezczynności (oszczędność RAM)
const MIN_GAP_MS = 4000;

let browser = null;
let context = null;
let idleTimer = null;
let queue = Promise.resolve();
let lastNavAt = 0;

function loadPlaywright() {
  try {
    return require('playwright');
  } catch {
    throw new Error('Brak modułu przeglądarki. W folderze aplikacji uruchom: npm install, a potem: npx playwright install chromium');
  }
}

async function getContext() {
  if (context) return context;
  const { chromium } = loadPlaywright();
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined });
  } catch (err) {
    if (/Executable doesn't exist|install/i.test(err.message)) {
      throw new Error('Brak przeglądarki Chromium. W folderze aplikacji uruchom: npx playwright install chromium');
    }
    throw err;
  }
  context = await browser.newContext({
    storageState: fs.existsSync(STATE_FILE) ? STATE_FILE : undefined,
    locale: 'de-CH',
    timezoneId: 'Europe/Zurich',
    viewport: { width: 1280, height: 900 },
  });
  return context;
}

async function saveState() {
  if (context) await context.storageState({ path: STATE_FILE }).catch(() => {});
}

async function close() {
  const b = browser;
  browser = null;
  context = null;
  if (b) await b.close().catch(() => {});
}

function scheduleIdleClose() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    queue = queue.then(close);
  }, IDLE_CLOSE_MS);
  idleTimer.unref?.();
}

/** Wszystkie operacje po kolei (jedna karta naraz) + odstęp między wejściami na stronę. */
function run(fn) {
  const task = queue.then(async () => {
    const wait = MIN_GAP_MS + Math.random() * 2000 - (Date.now() - lastNavAt);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastNavAt = Date.now();
    const ctx = await getContext();
    const page = await ctx.newPage();
    try {
      return await fn(page);
    } finally {
      await saveState();
      await page.close().catch(() => {});
      scheduleIdleClose();
    }
  });
  queue = task.catch(() => {});
  return task;
}

const passwordVisible = (page) => page.locator('input[type="password"]:visible').count().then((n) => n > 0);

/** Czeka, aż aplikacja wyrenderuje formularz logowania albo treść. */
async function waitForApp(page, contentRe) {
  await page
    .waitForFunction(
      (re) => !!document.querySelector('input[type="password"]') || new RegExp(re, 'i').test(document.body?.innerText || ''),
      contentRe.source,
      { timeout: 30000 }
    )
    .catch(() => {});
}

async function doLogin(page, site) {
  await page.goto(site.loginUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await waitForApp(page, /Inserate|Aktuelle|Höchstgebot|Abmelden|Logout/);
  if (!(await passwordVisible(page))) {
    // brak formularza = sesja wciąż ważna
    return { alreadyLoggedIn: true };
  }
  const user = page.locator('input[type="email"]:visible, input[type="text"]:visible, input:not([type]):visible').first();
  if (!(await user.count())) throw new Error('Na stronie logowania nie znaleziono pola loginu / e-mail');
  await user.fill(site.username);
  const pw = page.locator('input[type="password"]:visible').first();
  await pw.fill(site.password);
  await pw.press('Enter');
  // gdy Enter nie wysyła formularza – kliknij przycisk logowania
  await page.waitForTimeout(2500);
  if (await passwordVisible(page)) {
    const btn = page
      .locator('button[type="submit"]:visible, button:visible, input[type="submit"]:visible')
      .filter({ hasText: /anmelden|login|einloggen|sign in|weiter/i })
      .first();
    if (await btn.count()) await btn.click().catch(() => {});
    else await page.locator('button[type="submit"]:visible').first().click().catch(() => {});
  }
  try {
    await page.waitForSelector('input[type="password"]', { state: 'detached', timeout: 20000 });
  } catch {
    if (await passwordVisible(page)) {
      const msg = (await page.locator("body").innerText()).match(/[^\n]{0,60}(falsch|ungültig|invalid|incorrect|nicht korrekt|fehlgeschlagen)[^\n]{0,60}/i);
      throw new Error(`Logowanie nieudane – sprawdź login i hasło${msg ? ` (strona: „${msg[0].trim()}”)` : ''}`);
    }
  }
  return { alreadyLoggedIn: false };
}

/** Logowanie w przeglądarce. */
function login(site) {
  return run((page) => doLogin(page, site));
}

/**
 * Otwiera stronę aukcji i zwraca jej widoczny tekst i HTML.
 * ensureLogin – funkcja z zabezpieczeniami przed blokadą konta (wywołuje login), gdy sesja wygasła.
 */
async function fetchPage(url, site, ensureLogin) {
  const open = (page) => async () => {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await waitForApp(page, /Inserat läuft bis|Höchstgebot|Marke/);
    await page.waitForTimeout(800); // dociągnięcie ostatnich danych
  };
  const first = await run(async (page) => {
    await open(page)();
    if (await passwordVisible(page)) return { needsLogin: true };
    return { text: await page.locator('body').innerText(), html: await page.content() };
  });
  if (!first.needsLogin) return first;
  await ensureLogin();
  const second = await run(async (page) => {
    await open(page)();
    if (await passwordVisible(page)) throw new Error('Po zalogowaniu strona aukcji nadal wymaga logowania');
    return { text: await page.locator('body').innerText(), html: await page.content() };
  });
  return second;
}

async function resetBrowserSession() {
  await (queue = queue.then(close));
  fs.rmSync(STATE_FILE, { force: true });
}

// ---------- Skan listy aktywnych aukcji ----------

/** W przeglądarce: oznacza kafelki aukcji (najmniejsze elementy z przebiegiem i czasem do końca) i zwraca ich tekst. */
function markCardsInPage() {
  const timeRe = /\d\s*(Minute|Stunde|Std|Tag|Sekunde)|\b\d{1,2}:\d{2}:\d{2}\b/i;
  const kmRe = /\d\s*km\b/i;
  const els = [...document.querySelectorAll('body *')].filter((el) => {
    if (el.children.length === 0 && el.tagName !== 'DIV') return false;
    const t = el.innerText || '';
    return kmRe.test(t) && timeRe.test(t) && t.length < 1500;
  });
  const minimal = els.filter((el) => !els.some((o) => o !== el && el.contains(o)));
  return minimal.map((el, i) => {
    el.setAttribute('data-am-card', String(i));
    const a = el.closest('a[href]') || el.querySelector('a[href]');
    return { index: i, text: el.innerText, href: a ? a.href : null };
  });
}

async function readCards(page) {
  return page.evaluate(markCardsInPage);
}

/** Przewija listę, aż widać aukcje kończące się później niż horyzont (lista posortowana po czasie końca). */
async function loadCards(page, horizonMin, parseCard) {
  let cards = [];
  for (let i = 0; i < 15; i++) {
    cards = await readCards(page);
    const parsed = cards.map((c) => parseCard(c.text));
    const last = parsed[parsed.length - 1];
    if (!cards.length || (last && last.minutesLeft != null && last.minutesLeft > horizonMin)) break;
    const before = cards.length;
    await page.evaluate(() => {
      const els = document.querySelectorAll('[data-am-card]');
      els[els.length - 1]?.scrollIntoView({ block: 'end' });
      window.scrollBy(0, window.innerHeight);
    });
    await page.waitForTimeout(1500);
    if ((await readCards(page)).length === before) break; // nic nowego się nie doładowało
  }
  return cards;
}

/**
 * Otwiera listę aukcji, czyta kafelki i dla wybranych (needsDetail) otwiera szczegóły.
 * @returns {{ cards: Array<{text, href}>, details: Array<{text, url, cardText}>, snapshot }}
 */
async function scanList(site, { listUrl, horizonMin, maxDetails, parseCard, needsDetail }, ensureLogin) {
  const openList = async (page) => {
    await page.goto(listUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page
      .waitForFunction(() => !!document.querySelector('input[type="password"]') || /\d\s*km\b/i.test(document.body?.innerText || ''), null, { timeout: 30000 })
      .catch(() => {});
    await page.waitForTimeout(1000);
  };

  const attempt = (page) =>
    (async () => {
      await openList(page);
      if (await passwordVisible(page)) return { needsLogin: true };
      const cards = await loadCards(page, horizonMin, parseCard);
      const snapshot = cards.length ? null : { text: (await page.locator('body').innerText()).slice(0, 20000), html: (await page.content()).slice(0, 300000) };
      const details = [];
      const wanted = cards.filter((c) => needsDetail(parseCard(c.text), c)).slice(0, maxDetails);
      for (const card of wanted) {
        try {
          if (card.href && !/^javascript:/i.test(card.href)) {
            await page.goto(card.href, { waitUntil: 'domcontentloaded', timeout: 45000 });
          } else {
            // Kafelek bez linku (aplikacja): klik → szczegóły → powrót do listy
            const fresh = await readCards(page);
            const match = fresh.find((c) => c.text === card.text);
            if (!match) continue;
            await page.locator(`[data-am-card="${match.index}"]`).first().click({ timeout: 10000 });
          }
          await page.waitForFunction(() => /Inserat läuft bis|Inseratnummer/i.test(document.body?.innerText || ''), null, { timeout: 20000 });
          await page.waitForTimeout(700);
          details.push({ cardText: card.text, url: page.url(), text: await page.locator('body').innerText() });
        } catch (err) {
          details.push({ cardText: card.text, error: err.message });
        }
        await page.waitForTimeout(2500 + Math.random() * 2000); // spokojne tempo – ochrona konta
        await openList(page);
        await loadCards(page, horizonMin, parseCard);
      }
      return { cards, details, snapshot };
    })();

  const first = await run(attempt);
  if (!first.needsLogin) return first;
  await ensureLogin();
  const second = await run(attempt);
  if (second.needsLogin) throw new Error('Po zalogowaniu lista aukcji nadal wymaga logowania');
  return second;
}

module.exports = { login, fetchPage, scanList, close, resetBrowserSession };
