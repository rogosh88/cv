const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'am-bcp-'));

const { parseBestCarPriceText } = require('../src/sites/bestcarprice');
const { otomotoModelSlug, modelTokens } = require('../src/market/otomoto');
const { buildApiUrl } = require('../src/market/olx');

// Tekst strony szczegółów (jak document.body.innerText) – na podstawie zrzutów ekranu
const PAGE = `Detail
MERCEDES-BENZ E 220 d
Inseratnummer: ce176
Inserat läuft bis\t24.11.2026 - 20:00
Marke\tMERCEDES-BENZ
Modell\tE 220 d
1. Inverkehrssetzung\t08.2017
Letzte bestandene MFK\t07.2024
KM-Stand bei Übergabe\t114'421 km
Fahrzeug verfügbar ab\t28.11.2026
Treibstoff\tDiesel
Emissionscode\tB6c
Getriebeart\tAutomat
Antrieb\tHeck
Leistung in KW\t143 KW
Leistung in PS\t194 PS
Aussenfarbe\tschwarz
Innenfarbe\tschwarz
Chassisnummer\tWDD2132041A245087
Typenscheinnummer\tX
Stammnummer\t160.956.707
Technisch
Kein Dieselpartikelfiltertest vorhanden, da nicht durchgeführt!
Warnlampe leuchtet / Fahrzeug nicht fahrbar
Bereifung
Felgen teilweise beschädigt
Allgemein
Zweitschlüssel vorhanden
Innenraum
Nichtraucherauto
- Fz hat Gebrauchspruren siehe Bilder!
Verkauf ausschliesslich ab Platz. Sämtliche Mängel sind Sache des Käufers.
Vertragspartner/Abholort:
LIGA Lindengut-Garage AG
Toggenburgerstrasse 146
9500 Wil SG
Garage folgen
45 Minuten
Aktuelles Höchstgebot: CHF 6'600
Mein Gebot: CHF 6'500`;

test('bestcarprice: rozpoznanie danych ze strony szczegółów', () => {
  const r = parseBestCarPriceText(PAGE, 'https://app.bestcarprice.ch/detail/ce176');
  assert.strictEqual(r.externalId, 'ce176');
  assert.strictEqual(r.make, 'Mercedes-Benz');
  assert.strictEqual(r.model, 'E 220 d');
  assert.strictEqual(r.year, 2017);
  assert.strictEqual(r.mileageKm, 114421);
  assert.strictEqual(r.fuel, 'diesel');
  assert.strictEqual(r.powerKw, 143);
  assert.strictEqual(r.vin, 'WDD2132041A245087');
  assert.strictEqual(r.currentPrice, 6600);
  assert.strictEqual(r.myBid, 6500);
  assert.strictEqual(r.endsAt, '2026-11-24T19:00:00.000Z'); // 20:00 czasu szwajcarskiego (zima)
  assert.strictEqual(r.sellerName, 'LIGA Lindengut-Garage AG');
  assert.strictEqual(r.sellerAddress, 'Toggenburgerstrasse 146, 9500 Wil SG, Schweiz');
  assert.match(r.conditionNotes, /nicht fahrbar/);
  assert.strictEqual(r.engineCc, undefined); // strona nie podaje pojemności
});

test('bestcarprice: etykieta i wartość w osobnych liniach (inny układ tekstu)', () => {
  const alt = PAGE.replace(/\t/g, '\n');
  const r = parseBestCarPriceText(alt);
  assert.strictEqual(r.make, 'Mercedes-Benz');
  assert.strictEqual(r.mileageKm, 114421);
  assert.strictEqual(r.endsAt, '2026-11-24T19:00:00.000Z');
});

test('Otomoto: nazwy modeli z aukcji → slug Otomoto', () => {
  assert.strictEqual(otomotoModelSlug('Mercedes-Benz', 'E 220 d'), 'klasa-e');
  assert.strictEqual(otomotoModelSlug('MERCEDES-BENZ', 'C 200 4Matic'), 'klasa-c');
  assert.strictEqual(otomotoModelSlug('Mercedes-Benz', 'GLC 300 d'), 'glc');
  assert.strictEqual(otomotoModelSlug('BMW', '320d Touring'), 'seria-3');
  assert.strictEqual(otomotoModelSlug('BMW', 'X5 xDrive30d'), 'x5');
  assert.strictEqual(otomotoModelSlug('Audi', 'A6 Avant 40 TDI'), 'a6');
  assert.strictEqual(otomotoModelSlug('VW', 'Golf 2.0 TDI'), 'golf');
  assert.deepStrictEqual(modelTokens('E 220 d'), ['220']);
});

test('OLX: fraza wyszukiwania w stylu polskich ogłoszeń', () => {
  assert.match(buildApiUrl({ make: 'Mercedes-Benz', model: 'E 220 d' }), /query=mercedes\+e\+220d/);
});
