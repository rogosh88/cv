// Wysyłka powiadomień: Web Push (PWA na iPhonie), Telegram, ntfy.
const fs = require('fs');
const path = require('path');
const webpush = require('web-push');
const store = require('./store');
const { getSettings } = require('./settings');

let vapid;
function getVapid() {
  if (vapid) return vapid;
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    vapid = { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  } else {
    const f = path.join(store.DATA_DIR, 'vapid.json');
    try {
      vapid = JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch {
      vapid = webpush.generateVAPIDKeys();
      fs.writeFileSync(f, JSON.stringify(vapid, null, 2));
    }
  }
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@example.com', vapid.publicKey, vapid.privateKey);
  return vapid;
}

async function sendWebPush(payload) {
  getVapid();
  const subs = store.listSubscriptions();
  let sent = 0;
  for (const sub of subs) {
    try {
      await webpush.sendNotification(sub, JSON.stringify(payload), { TTL: 3600, urgency: 'high' });
      sent++;
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) store.removeSubscription(sub.endpoint);
      else console.warn('[push]', err.statusCode || '', err.message);
    }
  }
  return sent;
}

async function sendTelegram({ botToken, chatId }, text) {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: false }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Telegram HTTP ${res.status}: ${await res.text()}`);
}

async function sendNtfy({ server, topic }, { title, body, url }) {
  const res = await fetch(`${(server || 'https://ntfy.sh').replace(/\/$/, '')}/${encodeURIComponent(topic)}`, {
    method: 'POST',
    headers: { Title: encodeHeader(title), Priority: 'high', Tags: 'car,moneybag', ...(url ? { Click: url } : {}) },
    body,
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`ntfy HTTP ${res.status}`);
}

// Nagłówki HTTP muszą być ASCII – ntfy obsługuje kodowanie RFC 2047
function encodeHeader(s) {
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
}

/** Wysyła wiadomość wszystkimi włączonymi kanałami. Zwraca raport. */
async function notify({ title, body, url, appUrl }) {
  const n = getSettings().notifications;
  const report = {};
  if (n.webPush?.enabled) {
    try {
      report.webPush = `wysłano: ${await sendWebPush({ title, body, url: appUrl || url })}`;
    } catch (e) {
      report.webPush = `błąd: ${e.message}`;
    }
  }
  if (n.telegram?.enabled && n.telegram.botToken && n.telegram.chatId) {
    try {
      const link = url ? `\n\n<a href="${escapeHtml(url)}">Otwórz aukcję</a>` : '';
      await sendTelegram(n.telegram, `<b>${escapeHtml(title)}</b>\n${escapeHtml(body)}${link}`);
      report.telegram = 'ok';
    } catch (e) {
      report.telegram = `błąd: ${e.message}`;
    }
  }
  if (n.ntfy?.enabled && n.ntfy.topic) {
    try {
      await sendNtfy(n.ntfy, { title, body, url });
      report.ntfy = 'ok';
    } catch (e) {
      report.ntfy = `błąd: ${e.message}`;
    }
  }
  console.log('[notify]', title, report);
  return report;
}

module.exports = { notify, getVapid };
