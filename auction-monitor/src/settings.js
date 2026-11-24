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

  // Pozycje kosztowe, liczone po kolei. Wartości PRZYKŁADOWE – uzupełnij swoimi.
  //  type 'fixed'   – kwota stała (currency: PLN / CHF / EUR)
  //  type 'percent' – procent od: base 'price' (cena aukcji) albo 'running' (cena + wszystkie wcześniejsze pozycje)
  //  engineCcMin / engineCcMax – opcjonalny warunek pojemności silnika (gdy nieznana → przyjmujemy dużą, czyli wariant ostrożny)
  costs: [
    { id: 'fee', name: 'Prowizja domu aukcyjnego', type: 'percent', pct: 0, base: 'price' },
    { id: 'transport', name: 'Transport CH → PL', type: 'fixed', amount: 3500, currency: 'PLN' },
    { id: 'duty', name: 'Cło', type: 'percent', pct: 10, base: 'running' },
    { id: 'excise-small', name: 'Akcyza (do 2000 cm³)', type: 'percent', pct: 3.1, base: 'running', engineCcMax: 2000 },
    { id: 'excise-big', name: 'Akcyza (powyżej 2000 cm³)', type: 'percent', pct: 18.6, base: 'running', engineCcMin: 2001 },
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
    cookie: '',
    priceSelector: '',
    endTimeSelector: '',
    refreshMinutes: 10,
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

function getSettings() {
  return deepMerge(DEFAULT_SETTINGS, store.read('settings', {}));
}

function saveSettings(patch) {
  const next = deepMerge(getSettings(), patch || {});
  store.write('settings', next);
  return next;
}

module.exports = { DEFAULT_SETTINGS, getSettings, saveSettings, deepMerge };
