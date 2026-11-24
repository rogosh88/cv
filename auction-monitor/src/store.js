// Prosty magazyn danych w plikach JSON (bez bazy danych – łatwy deploy).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

function file(name) {
  return path.join(DATA_DIR, `${name}.json`);
}

function read(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file(name), 'utf8'));
  } catch {
    return fallback;
  }
}

function write(name, value) {
  const tmp = file(name) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file(name));
}

const id = () => crypto.randomBytes(6).toString('hex');

// ---- Aukcje ----
function listAuctions() {
  return read('auctions', []);
}
function saveAuctions(list) {
  write('auctions', list);
}
function getAuction(auctionId) {
  return listAuctions().find((a) => a.id === auctionId);
}
function upsertAuction(auction) {
  const list = listAuctions();
  const i = list.findIndex((a) => a.id === auction.id);
  if (i >= 0) list[i] = auction;
  else list.push(auction);
  saveAuctions(list);
  return auction;
}
function deleteAuction(auctionId) {
  saveAuctions(listAuctions().filter((a) => a.id !== auctionId));
}

// ---- Historia powiadomień ----
function listAlerts() {
  return read('alerts', []);
}
function addAlert(alert) {
  const list = listAlerts();
  list.unshift({ id: id(), createdAt: new Date().toISOString(), ...alert });
  write('alerts', list.slice(0, 200));
}

// ---- Subskrypcje Web Push ----
function listSubscriptions() {
  return read('push-subscriptions', []);
}
function addSubscription(sub) {
  const list = listSubscriptions().filter((s) => s.endpoint !== sub.endpoint);
  list.push(sub);
  write('push-subscriptions', list);
}
function removeSubscription(endpoint) {
  write('push-subscriptions', listSubscriptions().filter((s) => s.endpoint !== endpoint));
}

module.exports = {
  DATA_DIR,
  read,
  write,
  id,
  listAuctions,
  getAuction,
  upsertAuction,
  deleteAuction,
  listAlerts,
  addAlert,
  listSubscriptions,
  addSubscription,
  removeSubscription,
};
