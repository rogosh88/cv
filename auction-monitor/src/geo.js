// Odległość drogowa między adresami: geokodowanie OpenStreetMap (Nominatim) + trasa OSRM.
// Gdy routing jest niedostępny – odległość w linii prostej × 1,3 (przybliżenie drogowe).
const store = require('./store');

const UA = 'auction-monitor/1.0 (self-hosted)';
let lastNominatim = 0;

function cache() {
  return store.read('geocache', {});
}
function saveCache(c) {
  store.write('geocache', c);
}

async function geocode(address) {
  const key = address.trim().toLowerCase();
  const c = cache();
  if (c[key]) return c[key];
  // Zasady Nominatim: maks. 1 zapytanie na sekundę
  const wait = 1100 - (Date.now() - lastNominatim);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastNominatim = Date.now();
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(address)}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'de,pl,en' }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Geokodowanie HTTP ${res.status}`);
  const [hit] = await res.json();
  if (!hit) throw new Error(`Nie znaleziono adresu: ${address}`);
  const point = { lat: Number(hit.lat), lon: Number(hit.lon), label: hit.display_name };
  c[key] = point;
  saveCache(c);
  return point;
}

function haversineKm(a, b) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Zwraca odległość drogową w jedną stronę (km). */
async function drivingDistanceKm(fromAddress, toAddress) {
  const [a, b] = await Promise.all([geocode(fromAddress), geocode(toAddress)]);
  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${a.lon},${a.lat};${b.lon},${b.lat}?overview=false`;
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`OSRM HTTP ${res.status}`);
    const json = await res.json();
    const meters = json.routes?.[0]?.distance;
    if (!meters) throw new Error('Brak trasy');
    return { km: Math.round(meters / 100) / 10, method: 'trasa drogowa' };
  } catch (err) {
    return { km: Math.round(haversineKm(a, b) * 1.3), method: `przybliżenie (${err.message})` };
  }
}

module.exports = { drivingDistanceKm, geocode, haversineKm };
