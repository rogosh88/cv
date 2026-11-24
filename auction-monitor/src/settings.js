// Ustawienia aplikacji. Zapisywane w data/settings.json, edytowalne z poziomu aplikacji.
const store = require('./store');

const DEFAULT_SETTINGS = {
  // Powiadom, gdy łączny koszt sprowadzenia jest co najmniej X% poniżej wartości rynkowej w PL
  thresholdPct: 30,
  // Ile minut przed końcem aukcji wykonać porównanie
  checkMinutesBeforeEnd: 20,
  // Dodatkowe przypomnienie tuż przed końcem (0 = wyłączone)
  reminderMinutesBeforeEnd: 5,

  // Kurs CHF→PLN: 'nbp' (automatycznie, tabela A NBP) albo 'manual'
  fxMode: 'nbp',
  manualChfPln: 4.6,
  manualEurPln: 4.3,

  // Adres Twojego garażu – start i koniec trasy po auto w Szwajcarii
  garageAddress: '',

  // Pozycje kosztowe, liczone po kolei od góry. Wartości PRZYKŁADOWE – uzupełnij swoimi.
  //  type 'fixed'    – kwota stała (currency: PLN / CHF / EUR)
  //  type 'percent'  – procent od: base 'price' (cena aukcji) albo 'running' (cena + wszystkie wcześniejsze pozycje)
  //  type 'distance' – km (garaż → sprzedający) × trips (2 = w dwie strony) × ratePerKm (w walucie currency)
  //  engineCcMin / engineCcMax – opcjonalny warunek pojemności silnika (gdy nieznana → przyjmujemy dużą, czyli wariant ostrożny)
  costs: [
    { id: 'fee', name: 'Prowizja domu aukcyjnego', type: 'percent', pct: 0, base: 'price' },
    { id: 'ch-transport', name: 'Transport w Szwajcarii (garaż ↔ sprzedający)', type: 'distance', ratePerKm: 2, currency: 'CHF', trips: 2 },
    { id: 'transport', name: 'Transport CH → PL', type: 'fixed', amount: 3500, currency: 'PLN' },
    { id: 'duty', name: 'Cło', type: 'percent', pct: 10, base: 'running' },
    { id: 'excise-small', name: 'Akcyza (do 1999 cm³)', type: 'percent', pct: 4, base: 'running', engineCcMax: 1999 },
    { id: 'excise-big', name: 'Akcyza (od 2000 cm³)', type: 'percent', pct: 18, base: 'running', engineCcMin: 2000 },
    { id: 'vat', name: 'VAT', type: 'percent', pct: 23, base: 'running' },
    { id: 'other', name: 'Agencja celna, badanie, rejestracja', type: 'fixed', amount: 1500, currency: 'PLN' },
  ],

  // Wycena rynkowa
  market: {
    sources: { otomoto: true, olx: true },
    yearTolerance: 1, // ± lata
    mileageTolerancePct: 35, // ± % przebiegu
    minListings: 3, // minimum ogłoszeń, żeby uznać wycenę za wiarygodną
    statistic: 'median', // 'median' albo 'p25' (bardziej konserwatywnie – dolny kwartyl)
    askingPriceDiscountPct: 5, // ogłoszenia to ceny wywoławcze – realna cena transakcyjna zwykle trochę niższa
    cacheHours: 6,
  },

  // Strona z aukcjami (adapter ogólny) – opcjonalne selektory CSS i ciasteczko sesji
  auctionSite: {
    // Logowanie: adres strony logowania + login i hasło (formularz wypełniany automatycznie)
    loginUrl: '',
    username: '',
    password: '',
    cookie: '', // alternatywnie: ciasteczko sesji skopiowane z przeglądarki
    sellerAddressSelector: '',
    priceSelector: '',
    endTimeSelector: '',
    refreshMinutes: 30, // co ile minut odświeżać cenę, gdy do końca aukcji jest daleko
    nearEndRefreshMinutes: 2, // co ile minut tuż przed porównaniem (ok. 20 min przed końcem)
  },

  notifications: {
    telegram: { enabled: false, botToken: '', chatId: '' },
    ntfy: { enabled: false, server: 'https://ntfy.sh', topic: '' },
    webPush: { enabled: true },
  },
};

function isObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, override) {
  if (!isObject(base) || !isObject(override)) return override === undefined ? base : override;
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) {
    out[k] = isObject(v) && isObject(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

// Pola tajne – nie są odsyłane do przeglądarki; pusta wartość / maska przy zapisie = bez zmian
const SECRETS = ['auctionSite.password', 'auctionSite.cookie', 'notifications.telegram.botToken'];
const MASK = '••••••••';

function getPath(o, p) {
  return p.split('.').reduce((x, k) => (x == null ? x : x[k]), o);
}
function setPath(o, p, v) {
  const keys = p.split('.');
  let cur = o;
  for (const k of keys.slice(0, -1)) cur = cur[k] = isObject(cur[k]) ? cur[k] : {};
  cur[keys[keys.length - 1]] = v;
}

/** Ustawienia dla frontendu – sekrety zamaskowane. */
function publicSettings() {
  const s = JSON.parse(JSON.stringify(getSettings()));
  for (const p of SECRETS) if (getPath(s, p)) setPath(s, p, MASK);
  return s;
}

function getSettings() {
  return deepMerge(DEFAULT_SETTINGS, store.read('settings', {}));
}

function saveSettings(patch) {
  patch = JSON.parse(JSON.stringify(patch || {}));
  for (const p of SECRETS) {
    const v = getPath(patch, p);
    if (v === MASK) setPath(patch, p, getPath(getSettings(), p));
  }
  const next = deepMerge(getSettings(), patch || {});
  store.write('settings', next);
  return next;
}

module.exports = { DEFAULT_SETTINGS, getSettings, saveSettings, publicSettings, deepMerge, MASK };
