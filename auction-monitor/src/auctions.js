// Odświeżanie danych aukcji (aktualna cena, czas zakończenia) ze strony aukcyjnej.
// Adapter ogólny: JSON-LD / meta tagi / selektory CSS z ustawień. Gdy strona wymaga logowania,
// w ustawieniach można podać ciasteczko sesji. Gdy pobieranie się nie uda – cenę można aktualizować ręcznie.
const cheerio = require('cheerio');
const { getText, parseNumber } = require('./http');

function findInJsonLd($) {
  let price = null;
  let endsAt = null;
  let currency = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const walk = (v) => {
        if (!v || typeof v !== 'object') return;
        if (Array.isArray(v)) return v.forEach(walk);
        const offers = v.offers || (v['@type'] === 'Offer' || v['@type'] === 'AggregateOffer' ? v : null);
        if (offers) {
          const o = Array.isArray(offers) ? offers[0] : offers;
          price = price ?? parseNumber(o.price ?? o.highPrice ?? o.lowPrice);
          currency = currency ?? o.priceCurrency;
          endsAt = endsAt ?? o.priceValidUntil ?? o.availabilityEnds ?? null;
        }
        endsAt = endsAt ?? v.endDate ?? null;
        Object.values(v).forEach(walk);
      };
      walk(JSON.parse($(el).html()));
    } catch {}
  });
  return { price, endsAt, currency };
}

function parseAuctionHtml(html, siteSettings = {}) {
  const $ = cheerio.load(html);
  const result = { price: null, endsAt: null, currency: null };

  if (siteSettings.priceSelector) {
    const el = $(siteSettings.priceSelector).first();
    result.price = parseNumber(el.attr('content') || el.attr('data-price') || el.text());
  }
  if (siteSettings.endTimeSelector) {
    const el = $(siteSettings.endTimeSelector).first();
    const raw = el.attr('datetime') || el.attr('data-end') || el.attr('data-endtime') || el.attr('content') || el.text();
    const d = parseDate(raw);
    if (d) result.endsAt = d.toISOString();
  }

  const ld = findInJsonLd($);
  result.price = result.price ?? ld.price;
  result.currency = ld.currency;
  if (!result.endsAt && ld.endsAt) {
    const d = parseDate(ld.endsAt);
    if (d) result.endsAt = d.toISOString();
  }
  if (result.price == null) {
    const meta = $('meta[itemprop="price"], meta[property="product:price:amount"], [itemprop="price"]').first();
    result.price = parseNumber(meta.attr('content') || meta.text());
  }
  return result;
}

/** Obsługuje ISO, timestamp (s/ms) oraz format szwajcarski "24.11.2026 18:30" */
function parseDate(raw) {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim();
  if (/^\d{10,13}$/.test(s)) return new Date(Number(s) * (s.length === 10 ? 1000 : 1));
  const ch = s.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})[ ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (ch) {
    // Czas szwajcarski (Europe/Zurich) – ta sama strefa co Polska
    const [, d, m, y, hh, mm, ss] = ch;
    return zurichToDate(+y, +m, +d, +hh, +mm, +(ss || 0));
  }
  const d = new Date(s);
  return isNaN(d) ? null : d;
}

function zurichToDate(y, m, d, hh, mm, ss) {
  const guess = new Date(Date.UTC(y, m - 1, d, hh, mm, ss));
  const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Zurich', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const parts = Object.fromEntries(fmt.formatToParts(guess).map((p) => [p.type, p.value]));
  const asZurich = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second);
  return new Date(guess.getTime() - (asZurich - guess.getTime()));
}

async function refreshAuction(auction, siteSettings) {
  if (!auction.url) throw new Error('Brak adresu URL aukcji');
  const headers = siteSettings.cookie ? { Cookie: siteSettings.cookie } : {};
  const html = await getText(auction.url, { headers });
  const data = parseAuctionHtml(html, siteSettings);
  if (data.price == null) throw new Error('Nie znaleziono ceny na stronie aukcji (ustaw selektor CSS w ustawieniach)');
  return data;
}

module.exports = { refreshAuction, parseAuctionHtml, parseDate };
