'use strict';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const fmt = (n) => (n == null || isNaN(n) ? '—' : Math.round(n).toLocaleString('pl-PL'));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

let settings = null;
let auctions = [];

// ---------- API ----------
async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', 'x-app-password': localStorage.getItem('pw') || '' };
  const res = await fetch(path, { ...opts, headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  if (res.status === 401) {
    const pw = prompt('Hasło do aplikacji:');
    if (pw != null) {
      localStorage.setItem('pw', pw);
      return api(path, opts);
    }
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Błąd ${res.status}`);
  return json;
}

function toast(msg, ms = 2500) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), ms);
}

// ---------- Nawigacja ----------
function show(view) {
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
  $$('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  window.scrollTo(0, 0);
  if (view === 'alerts') loadAlerts();
}
$$('.tabbar button').forEach((b) =>
  b.addEventListener('click', () => {
    if (b.dataset.view === 'add') resetForm();
    show(b.dataset.view);
  })
);

// ---------- Lista aukcji ----------
function countdown(endsAt) {
  const ms = new Date(endsAt) - Date.now();
  if (ms <= 0) return { text: 'zakończona', cls: '' };
  const m = Math.floor(ms / 60000);
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  const s = Math.floor((ms % 60000) / 1000);
  const text = d > 0 ? `${d} d ${h} h` : h > 0 ? `${h} h ${m % 60} min` : `${m}:${String(s).padStart(2, '0')}`;
  const check = settings?.checkMinutesBeforeEnd ?? 20;
  return { text, cls: m < 5 ? 'critical' : m < check + 10 ? 'soon' : '' };
}

function auctionCard(a) {
  const e = a.evaluation || {};
  const cur = a.currency || 'CHF';
  const m = a.market;
  const label = a.title || [a.make, a.model, a.year].filter(Boolean).join(' ');
  const discount = e.discountPct;
  const ended = a.status !== 'active';
  const sources = m?.sources || {};
  const links = [
    a.url && `<a href="${esc(a.url)}" target="_blank" rel="noopener">Aukcja ↗</a>`,
    sources.otomoto?.searchUrl && `<a href="${esc(sources.otomoto.searchUrl)}" target="_blank" rel="noopener">Otomoto ↗</a>`,
    sources.olx?.searchUrl && `<a href="${esc(sources.olx.searchUrl)}" target="_blank" rel="noopener">OLX ↗</a>`,
    sources.facebook?.searchUrl && `<a href="${esc(sources.facebook.searchUrl)}" target="_blank" rel="noopener">Facebook ↗</a>`,
  ].filter(Boolean);
  const srcInfo = Object.entries(sources)
    .filter(([k]) => k !== 'facebook')
    .map(([k, s]) => (s.ok ? `${k}: ${s.used}/${s.found}` : `<span class="error">${k}: ${esc(s.error)}</span>`))
    .join(' · ');

  return `
  <article class="card auction ${e.isDeal ? 'deal' : ''} ${ended ? 'ended' : ''}" id="auction-${a.id}">
    <div class="head">
      <div>
        <div class="title">${esc(label)}</div>
        <div class="meta">${[a.mileageKm && fmt(a.mileageKm) + ' km', a.fuel, a.engineCc && a.engineCc + ' cm³'].filter(Boolean).join(' · ')}</div>
      </div>
      <div style="text-align:right">
        <div class="countdown" data-ends="${esc(a.endsAt)}"></div>
        ${e.isDeal ? `<span class="badge">OKAZJA −${Math.round(discount)}%</span>` : discount != null ? `<span class="badge neutral">${discount > 0 ? '−' : '+'}${Math.abs(Math.round(discount))}%</span>` : ''}
      </div>
    </div>
    <div class="grid">
      <div><div class="k">Cena teraz</div><div class="v">${fmt(a.currentPrice)} ${esc(cur)}</div></div>
      <div><div class="k">≈ PLN (kurs ${e.rate ? e.rate.toFixed(4) : '—'})</div><div class="v">${fmt(e.pricePln)}</div></div>
      <div><div class="k">Koszt w Polsce</div><div class="v">${fmt(e.totalPln)} PLN</div></div>
      <div><div class="k">Wartość rynkowa PL${a.marketValueOverridePln ? ' (ręcznie)' : m?.stats?.count ? ` (${m.stats.count} ogł.)` : ''}</div><div class="v">${fmt(e.marketValuePln)} PLN</div></div>
      <div><div class="k">Różnica</div><div class="v ${discount >= (settings?.thresholdPct ?? 30) ? 'good' : discount < 0 ? 'bad' : ''}">${discount != null ? discount + '%' : '—'}</div></div>
      <div><div class="k">Maks. stawka (próg ${settings?.thresholdPct ?? 30}%)</div><div class="v">${e.maxBid != null ? fmt(e.maxBid) + ' ' + esc(cur) : '—'}</div></div>
    </div>
    ${a.checkResult ? `<div class="small muted">Sprawdzono ${a.checkResult.minutesLeft} min przed końcem: ${a.checkResult.isDeal ? '✅ okazja – wysłano powiadomienie' : `${a.checkResult.discountPct ?? '—'}% – bez powiadomienia`}</div>` : ''}
    ${a.lastFetchError ? `<div class="error">Strona aukcji: ${esc(a.lastFetchError)}</div>` : ''}
    ${srcInfo ? `<div class="small muted">${srcInfo}</div>` : !a.marketValueOverridePln ? '<div class="small muted">Wycena rynkowa jeszcze nie pobrana.</div>' : ''}
    <div class="links">${links.join('')}</div>
    <details>
      <summary>Szczegóły kosztów i ogłoszeń</summary>
      ${breakdownTable(e)}
      ${m?.stats?.count ? `<p class="small muted">Rynek: min ${fmt(m.stats.min)} · Q1 ${fmt(m.stats.p25)} · mediana ${fmt(m.stats.median)} · Q3 ${fmt(m.stats.p75)} · max ${fmt(m.stats.max)} PLN</p>` : ''}
      ${m?.sample?.length ? `<ul class="sample">${m.sample.map((l) => `<li>${fmt(l.pricePln)} PLN – ${l.url ? `<a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.title || l.source)}</a>` : esc(l.title)} <span class="muted">(${esc(l.source)}${l.year ? ', ' + l.year : ''}${l.mileageKm ? ', ' + fmt(l.mileageKm) + ' km' : ''})</span></li>`).join('')}</ul>` : ''}
      ${a.notes ? `<p class="small">${esc(a.notes)}</p>` : ''}
    </details>
    <div class="card-actions">
      <button class="tiny" data-act="price" data-id="${a.id}">Zmień cenę</button>
      <button class="tiny" data-act="refresh" data-id="${a.id}">Odśwież wycenę</button>
      <button class="tiny ghost" data-act="edit" data-id="${a.id}">Edytuj</button>
      <button class="tiny ghost danger" data-act="delete" data-id="${a.id}">Usuń</button>
    </div>
  </article>`;
}

function breakdownTable(e) {
  if (!e || e.totalPln == null) return '';
  return `<table class="breakdown">
    <tr><td>Cena auta</td><td>${fmt(e.pricePln)} PLN</td></tr>
    ${(e.items || []).map((i) => `<tr><td>${esc(i.name)}</td><td>${fmt(i.amountPln)} PLN</td></tr>`).join('')}
    <tr class="total"><td>Razem w Polsce</td><td>${fmt(e.totalPln)} PLN</td></tr>
  </table>`;
}

function renderAuctions() {
  const showEnded = $('#show-ended').checked;
  const list = auctions.filter((a) => showEnded || a.status === 'active');
  $('#auction-list').innerHTML = list.map(auctionCard).join('');
  $('#empty').classList.toggle('hidden', list.length > 0);
  tickCountdowns();
  if (location.hash.startsWith('#auction-')) {
    document.getElementById(location.hash.slice(1))?.scrollIntoView({ block: 'center' });
  }
}

function tickCountdowns() {
  $$('.countdown').forEach((el) => {
    const c = countdown(el.dataset.ends);
    el.textContent = c.text;
    el.className = `countdown ${c.cls}`;
  });
}
setInterval(tickCountdowns, 1000);

async function loadAuctions() {
  auctions = await api('/api/auctions');
  renderAuctions();
}
$('#reload').addEventListener('click', () => loadAuctions().then(() => toast('Odświeżono')));
$('#show-ended').addEventListener('change', renderAuctions);
setInterval(() => document.visibilityState === 'visible' && loadAuctions().catch(() => {}), 30000);

$('#auction-list').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button[data-act]');
  if (!btn) return;
  const a = auctions.find((x) => x.id === btn.dataset.id);
  try {
    if (btn.dataset.act === 'delete') {
      if (!confirm('Usunąć tę aukcję?')) return;
      await api(`/api/auctions/${a.id}`, { method: 'DELETE' });
    } else if (btn.dataset.act === 'price') {
      const p = prompt(`Aktualna cena (${a.currency || 'CHF'}):`, a.currentPrice ?? '');
      if (p == null) return;
      await api(`/api/auctions/${a.id}`, { method: 'PUT', body: { currentPrice: p } });
    } else if (btn.dataset.act === 'refresh') {
      btn.disabled = true;
      btn.textContent = 'Pobieram…';
      await api(`/api/auctions/${a.id}/refresh`, { method: 'POST', body: {} });
      toast('Wycena odświeżona');
    } else if (btn.dataset.act === 'edit') {
      fillForm(a);
      show('add');
      return;
    }
    await loadAuctions();
  } catch (err) {
    toast(err.message, 4000);
    loadAuctions();
  }
});

// ---------- Formularz aukcji ----------
function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const off = d.getTimezoneOffset() * 60000;
  return new Date(d - off).toISOString().slice(0, 16);
}

function resetForm() {
  const f = $('#auction-form');
  f.reset();
  f.id.value = '';
  $('#form-title').textContent = 'Dodaj aukcję';
}

function fillForm(a) {
  const f = $('#auction-form');
  resetForm();
  $('#form-title').textContent = 'Edytuj aukcję';
  for (const el of f.elements) {
    if (!el.name) continue;
    const v = a[el.name];
    if (el.type === 'checkbox') el.checked = v !== false;
    else if (el.name === 'endsAt') el.value = toLocalInput(v);
    else if (el.name === 'manualPrices') el.value = (v || []).join(', ');
    else el.value = v ?? '';
  }
}

$('#form-cancel').addEventListener('click', () => show('auctions'));
$('#auction-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  const body = {};
  for (const el of f.elements) {
    if (!el.name || el.name === 'id') continue;
    body[el.name] = el.type === 'checkbox' ? el.checked : el.value;
  }
  body.endsAt = new Date(body.endsAt).toISOString();
  try {
    const id = f.id.value;
    const saved = await api(id ? `/api/auctions/${id}` : '/api/auctions', { method: id ? 'PUT' : 'POST', body });
    toast('Zapisano – pobieram wycenę rynkową…');
    show('auctions');
    await loadAuctions();
    api(`/api/auctions/${saved.id}/refresh`, { method: 'POST', body: {} })
      .then(() => loadAuctions())
      .catch((err) => toast(err.message, 4000));
  } catch (err) {
    toast(err.message, 4000);
  }
});

// ---------- Kalkulator ----------
$('#calc-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const body = Object.fromEntries(new FormData(ev.target));
  try {
    const e = await api('/api/calc', { method: 'POST', body });
    $('#calc-result').innerHTML = `<div class="card ${e.isDeal ? 'auction deal' : ''}">
      ${breakdownTable(e)}
      ${e.marketValuePln ? `<p>Wartość rynkowa: <b>${fmt(e.marketValuePln)} PLN</b> → różnica <b>${e.discountPct}%</b> ${e.isDeal ? '✅ okazja' : ''}<br/>Maks. stawka dla progu ${settings.thresholdPct}%: <b>${fmt(e.maxBid)} ${esc(body.currency)}</b></p>` : ''}
    </div>`;
  } catch (err) {
    toast(err.message, 4000);
  }
});

// ---------- Alerty ----------
async function loadAlerts() {
  const list = await api('/api/alerts');
  $('#alert-list').innerHTML = list.length
    ? list
        .map(
          (a) => `<div class="card"><div class="small muted">${new Date(a.createdAt).toLocaleString('pl-PL')}</div>
          <b>${esc(a.title)}</b><pre style="white-space:pre-wrap;font:inherit;margin:6px 0">${esc(a.body)}</pre>
          ${a.url ? `<a href="${esc(a.url)}" target="_blank" rel="noopener">Otwórz aukcję ↗</a>` : ''}</div>`
        )
        .join('')
    : '<p class="muted center">Jeszcze nie było żadnych okazji.</p>';
}

// ---------- Ustawienia ----------
const getPath = (o, p) => p.split('.').reduce((x, k) => (x == null ? x : x[k]), o);
function setPath(o, p, v) {
  const keys = p.split('.');
  let cur = o;
  keys.slice(0, -1).forEach((k) => (cur = cur[k] ??= {}));
  cur[keys.at(-1)] = v;
}

function costRow(item = { type: 'fixed', currency: 'PLN', base: 'running' }) {
  const node = $('#cost-item-tpl').content.firstElementChild.cloneNode(true);
  node.dataset.type = item.type;
  node.dataset.id = item.id || Math.random().toString(36).slice(2, 8);
  $$('[data-k]', node).forEach((el) => (el.value = item[el.dataset.k] ?? (el.tagName === 'SELECT' ? el.options[0].value : '')));
  $('[data-k="type"]', node).addEventListener('change', (e) => (node.dataset.type = e.target.value));
  return node;
}

function renderSettings() {
  const f = $('#settings-form');
  for (const el of f.elements) {
    if (!el.name) continue;
    const v = getPath(settings, el.name);
    if (el.type === 'checkbox') el.checked = !!v;
    else el.value = v ?? '';
  }
  const box = $('#cost-items');
  box.innerHTML = '';
  settings.costs.forEach((c) => box.appendChild(costRow(c)));
}

$('#cost-items').addEventListener('click', (ev) => {
  const btn = ev.target.closest('button[data-act]');
  if (!btn) return;
  const row = btn.closest('.cost-item');
  if (btn.dataset.act === 'del') row.remove();
  if (btn.dataset.act === 'up' && row.previousElementSibling) row.parentNode.insertBefore(row, row.previousElementSibling);
});
$('#add-cost').addEventListener('click', () => $('#cost-items').appendChild(costRow()));

$('#settings-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const patch = {};
  for (const el of ev.target.elements) {
    if (!el.name) continue;
    let v = el.type === 'checkbox' ? el.checked : el.value;
    if (el.type === 'number') v = v === '' ? null : Number(v);
    setPath(patch, el.name, v);
  }
  patch.costs = $$('.cost-item').map((row) => {
    const item = { id: row.dataset.id };
    $$('[data-k]', row).forEach((el) => {
      const v = el.value;
      item[el.dataset.k] = el.type === 'number' ? (v === '' ? null : Number(v)) : v;
    });
    if (item.type === 'fixed') { delete item.pct; delete item.base; } else { delete item.amount; delete item.currency; }
    return item;
  });
  try {
    settings = await api('/api/settings', { method: 'PUT', body: patch });
    renderSettings();
    toast('Ustawienia zapisane');
    loadAuctions();
  } catch (err) {
    toast(err.message, 4000);
  }
});

$('#test-notify').addEventListener('click', async () => {
  try {
    const r = await api('/api/notify/test', { method: 'POST', body: {} });
    $('#notify-report').textContent = Object.entries(r).map(([k, v]) => `${k}: ${v}`).join(' · ') || 'Brak włączonych kanałów (zapisz ustawienia).';
  } catch (err) {
    toast(err.message, 4000);
  }
});

// ---------- Web Push ----------
function urlB64ToUint8Array(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

$('#enable-push').addEventListener('click', async () => {
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      const ios = /iPhone|iPad/.test(navigator.userAgent);
      throw new Error(ios ? 'Na iPhonie: Safari → Udostępnij → „Dodaj do ekranu początkowego”, potem otwórz aplikację z ikony i spróbuj ponownie.' : 'Ta przeglądarka nie obsługuje powiadomień push.');
    }
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') throw new Error('Brak zgody na powiadomienia');
    const reg = await navigator.serviceWorker.ready;
    const { publicKey } = await api('/api/push/key');
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8Array(publicKey) });
    await api('/api/push/subscribe', { method: 'POST', body: sub.toJSON() });
    toast('Powiadomienia włączone na tym urządzeniu ✅');
  } catch (err) {
    toast(err.message, 6000);
  }
});

// ---------- Start ----------
async function init() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  try {
    settings = await api('/api/settings');
    renderSettings();
    await loadAuctions();
    const fx = await api('/api/fx');
    $('#fx').textContent = `CHF ${fx.CHF.toFixed(4)} · EUR ${fx.EUR.toFixed(4)}`;
  } catch (err) {
    toast(err.message, 5000);
  }
}
init();
