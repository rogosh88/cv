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

module.exports = { login, fetchPage, close, resetBrowserSession };
