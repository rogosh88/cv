// Test logowania i odczytu strony-aplikacji (treść budowana skryptem) w ukrytej przeglądarce.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'am-browser-'));

let hasBrowser = true;
try {
  require.resolve('playwright');
} catch {
  hasBrowser = false;
}

const DETAIL = [
  ['Inserat läuft bis', '28.11.2026 - 20:00'],
  ['Marke', 'MERCEDES-BENZ'],
  ['Modell', 'E 220 d'],
  ['1. Inverkehrssetzung', '08.2017'],
  ['KM-Stand bei Übergabe', "114'421 km"],
  ['Treibstoff', 'Diesel'],
];

function spaServer() {
  const loginForm = `
    <form id="f"><input type="email" placeholder="E-Mail"><input type="password" placeholder="Passwort"><button type="submit">Anmelden</button><p id="err"></p></form>`;
  const page = (script) => `<!doctype html><html><body><div id="app">Laden…</div><script>${script}</script></body></html>`;
  const loginScript = (after) => `
    function showLogin(){
      document.getElementById('app').innerHTML = ${JSON.stringify(loginForm)};
      document.getElementById('f').onsubmit = async (e) => {
        e.preventDefault();
        const [u,p] = document.querySelectorAll('input');
        const r = await fetch('/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({u:u.value,p:p.value})});
        if (r.ok) location.href = ${JSON.stringify(after)}; else document.getElementById('err').textContent='Passwort falsch';
      };
    }`;
  let logins = 0;
  const server = http.createServer((req, res) => {
    const authed = (req.headers.cookie || '').includes('sid=ok');
    if (req.url === '/api/login') {
      logins++;
      let b = '';
      req.on('data', (c) => (b += c));
      return req.on('end', () => {
        const { u, p } = JSON.parse(b);
        if (u === 'jan@x.ch' && p === 'pw') {
          res.writeHead(200, { 'Set-Cookie': 'sid=ok; Path=/' });
          return res.end('{}');
        }
        res.writeHead(401);
        res.end('{}');
      });
    }
    if (req.url === '/api/detail') {
      if (!authed) {
        res.writeHead(401);
        return res.end();
      }
      return res.end(JSON.stringify({ rows: DETAIL, bid: "6'900", seller: ['LIGA Lindengut-Garage AG', 'Toggenburgerstrasse 146', '9500 Wil SG'] }));
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (req.url.startsWith('/login')) return res.end(page(loginScript('/?tab=active') + `setTimeout(showLogin, 300);`));
    if (req.url.startsWith('/detail')) {
      return res.end(
        page(
          loginScript(req.url) +
            `fetch('/api/detail').then(r => r.status === 401 ? showLogin() : r.json().then(d => {
              document.getElementById('app').innerHTML = '<h1>MERCEDES-BENZ E 220 d</h1><p>Inseratnummer: ce176</p><table>' +
                d.rows.map(([k,v]) => '<tr><td>'+k+'</td><td>'+v+'</td></tr>').join('') + '</table>' +
                '<p>Vertragspartner/Abholort:</p>' + d.seller.map(l => '<p>'+l+'</p>').join('') +
                '<p>Aktuelles Höchstgebot: CHF ' + d.bid + '</p>';
            }));`
        )
      );
    }
    res.end(page(`document.getElementById('app').textContent = ${authed} ? 'Inserate Aktuelle (378)' : 'Bitte anmelden';`));
  });
  server.loginCount = () => logins;
  return server;
}

test('przeglądarka: logowanie do strony-aplikacji i odczyt aukcji', { skip: !hasBrowser && 'brak playwright', timeout: 120000 }, async () => {
  const { refreshAuction, resetSession, login } = require('../src/auctions');
  const browser = require('../src/browser');
  const server = spaServer();
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    resetSession();
    await new Promise((r) => setTimeout(r, 200));
    const site = { mode: 'browser', loginUrl: `${base}/login`, username: 'jan@x.ch', password: 'pw' };
    // Strona aukcji bez sesji → logowanie → ponowne otwarcie
    const data = await refreshAuction({ url: `${base}/detail/ce176` }, site);
    assert.strictEqual(data.price, 6900);
    assert.strictEqual(data.endsAt, '2026-11-28T19:00:00.000Z');
    assert.strictEqual(data.sellerAddress, 'Toggenburgerstrasse 146, 9500 Wil SG, Schweiz');
    assert.strictEqual(server.loginCount(), 1);
    // Kolejne odczyty używają zapisanej sesji – bez ponownego logowania
    await refreshAuction({ url: `${base}/detail/ce176` }, site);
    assert.strictEqual(server.loginCount(), 1);
    // Złe hasło → czytelny błąd
    await browser.resetBrowserSession();
    await assert.rejects(login({ ...site, password: 'zle' }, { force: true }), /Logowanie nieudane.*Passwort falsch/);
  } finally {
    resetSession();
    await browser.close();
    server.close();
  }
});
