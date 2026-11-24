// Skan listy aukcji w ukrytej przeglądarce: kafelki bez linków (aplikacja), klik → szczegóły → powrót.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'am-scan-'));

let hasBrowser = true;
try {
  require.resolve('playwright');
} catch {
  hasBrowser = false;
}

function endsIn(min) {
  const d = new Date(Date.now() + min * 60000);
  const z = new Intl.DateTimeFormat('de-CH', { timeZone: 'Europe/Zurich', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
  return z.replace(', ', ' - ');
}

const CARS = [
  { id: 'ce176', title: 'MERCEDES-BENZ E 220 d', make: 'MERCEDES-BENZ', model: 'E 220 d', reg: '08.2017', km: "114'421", bid: "6'600", min: 45, seller: ['LIGA Lindengut-Garage AG', 'Toggenburgerstrasse 146', '9500 Wil SG'] },
  { id: 'vw221', title: 'VW GOLF 2.0 TDI', make: 'VW', model: 'Golf 2.0 TDI', reg: '03.2016', km: "98'000", bid: "4'200", min: 130, seller: ['Auto Muster AG', 'Hauptstrasse 1', '8000 Zürich'] },
  { id: 'bm900', title: 'BMW 320d', make: 'BMW', model: '320d', reg: '05.2019', km: "60'000", bid: "9'000", min: 2 * 1440, seller: ['X AG', 'Y 1', '3000 Bern'] },
];

function server() {
  let detailOpens = 0;
  const html = (s) => `<!doctype html><html><body><div id="app">Laden…</div><script>${s}</script></body></html>`;
  const script = `
    const app = document.getElementById('app');
    function login(){ app.innerHTML = '<form id=f><input type=email><input type=password><button>Anmelden</button></form>';
      document.getElementById('f').onsubmit = async e => { e.preventDefault(); const [u,p]=document.querySelectorAll('input');
        const r = await fetch('/api/login',{method:'POST',body:JSON.stringify({u:u.value,p:p.value})}); if (r.ok) location.href='/?tab=active'; }; }
    async function detail(id){ const r = await fetch('/api/detail/'+id); if (r.status===401) return login(); const c = await r.json();
      app.innerHTML = '<h1>'+c.title+'</h1><p>Inseratnummer: '+c.id+'</p><table>' +
        [['Inserat läuft bis',c.ends],['Marke',c.make],['Modell',c.model],['1. Inverkehrssetzung',c.reg],['KM-Stand bei Übergabe',c.km+' km'],['Treibstoff','Diesel']]
        .map(([k,v])=>'<tr><td>'+k+'</td><td>'+v+'</td></tr>').join('') + '</table><p>Vertragspartner/Abholort:</p>' + c.seller.map(l=>'<p>'+l+'</p>').join('') +
        '<p>Aktuelles Höchstgebot: CHF '+c.bid+'</p>'; }
    async function list(){ const r = await fetch('/api/list'); if (r.status===401) return login(); const cars = await r.json();
      app.innerHTML = '<h2>Inserate</h2><div>AKTUELLE (378)</div>' + cars.map(c => '<div class="card" data-id="'+c.id+'"><div><span>Aktuelles Höchstgebot: CHF '+c.bid+'</span></div><div>'+c.left+'</div><div class="body"><h3>'+c.title+'</h3><div>'+c.reg+' &nbsp; '+c.km+' km</div><div>Automat</div></div></div>').join('');
      document.querySelectorAll('.card').forEach(el => el.onclick = () => { history.pushState({}, '', '/detail/'+el.dataset.id); detail(el.dataset.id); }); }
    window.onpopstate = route;
    function route(){ if (location.pathname.startsWith('/detail/')) detail(location.pathname.split('/')[2]); else if (location.pathname==='/login') login(); else list(); }
    setTimeout(route, 200);`;
  const s = http.createServer((req, res) => {
    const authed = (req.headers.cookie || '').includes('sid=ok');
    if (req.url === '/api/login') {
      res.writeHead(200, { 'Set-Cookie': 'sid=ok; Path=/' });
      return res.end('{}');
    }
    if (req.url.startsWith('/api/')) {
      if (!authed) {
        res.writeHead(401);
        return res.end();
      }
      if (req.url === '/api/list') {
        const fmtLeft = (m) => (m < 60 ? `${m} Minuten` : m < 1440 ? `${Math.round(m / 60)} Stunden` : `${Math.round(m / 1440)} Tage`);
        return res.end(JSON.stringify(CARS.map((c) => ({ ...c, left: fmtLeft(c.min) }))));
      }
      const c = CARS.find((x) => req.url.endsWith('/' + x.id));
      detailOpens++;
      return res.end(JSON.stringify({ ...c, ends: endsIn(c.min) }));
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(html(script));
  });
  s.detailOpens = () => detailOpens;
  return s;
}

test('skan listy: dodaje aukcje kończące się w horyzoncie, potem aktualizuje ceny z listy', { skip: !hasBrowser && 'brak playwright', timeout: 180000 }, async () => {
  const store = require('../src/store');
  const { getSettings } = require('../src/settings');
  const monitor = require('../src/monitor');
  const browser = require('../src/browser');
  const { resetSession } = require('../src/auctions');
  const srv = server();
  await new Promise((r) => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const settings = getSettings();
  settings.fxMode = 'manual';
  settings.auctionSite = { ...settings.auctionSite, mode: 'browser', loginUrl: `${base}/login`, listUrl: `${base}/?tab=active`, username: 'a@b.ch', password: 'x', autoImport: true, horizonMinutes: 180 };
  try {
    resetSession();
    await new Promise((r) => setTimeout(r, 200));
    const st = await monitor.discover(settings, { force: true });
    assert.deepStrictEqual(st.errors, []);
    assert.strictEqual(st.cards, 3);
    assert.strictEqual(st.inHorizon, 2);
    assert.strictEqual(st.imported, 2);
    const list = store.listAuctions();
    const merc = list.find((a) => a.externalId === 'ce176');
    assert.ok(merc, 'Mercedes dodany');
    assert.strictEqual(merc.currentPrice, 6600);
    assert.match(merc.url, /\/detail\/ce176$/);
    assert.strictEqual(merc.sellerAddress, 'Toggenburgerstrasse 146, 9500 Wil SG, Schweiz');
    assert.ok(Math.abs(monitor.minutesLeft(merc) - 45) < 2);
    assert.ok(!list.some((a) => a.externalId === 'bm900'), 'aukcja za 2 dni pominięta');
    const opens = srv.detailOpens();

    // Druga runda: nowa cena na liście → aktualizacja bez otwierania szczegółów
    CARS[0].bid = "7'250";
    const st2 = await monitor.discover(settings, { force: true });
    assert.strictEqual(st2.imported, 0);
    assert.strictEqual(st2.updated, 2);
    assert.strictEqual(srv.detailOpens(), opens);
    assert.strictEqual(store.listAuctions().find((a) => a.externalId === 'ce176').currentPrice, 7250);
  } finally {
    await browser.close();
    srv.close();
  }
});
