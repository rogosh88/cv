// Kalkulacja całkowitego kosztu sprowadzenia auta oraz ocena okazji.

function conditionMet(item, engineCc) {
  // Nieznana pojemność → zakładamy dużą (wariant ostrożny – wyższa akcyza)
  const cc = Number(engineCc) > 0 ? Number(engineCc) : Infinity;
  if (item.engineCcMin != null && item.engineCcMin !== '' && !(cc >= Number(item.engineCcMin))) return false;
  if (item.engineCcMax != null && item.engineCcMax !== '' && !(cc <= Number(item.engineCcMax))) return false;
  return true;
}

/**
 * @param {number} price       cena aukcyjna w walucie aukcji
 * @param {object} opts        { currency, engineCc, distanceKm (w jedną stronę), costs, rates: {CHF, EUR, PLN} }
 * @returns {{ pricePln, totalPln, items: Array<{name, amountPln, note?, missing?}> }}
 */
function calculateTotal(price, { currency = 'CHF', engineCc, distanceKm, costs, rates }) {
  const toPln = (amount, cur) => {
    const r = rates[(cur || 'PLN').toUpperCase()];
    if (!r) throw new Error(`Brak kursu dla ${cur}`);
    return amount * r;
  };
  const pricePln = toPln(Number(price) || 0, currency);
  let running = pricePln;
  const items = [];
  for (const item of costs || []) {
    if (!conditionMet(item, engineCc)) continue;
    let amountPln = 0;
    let note;
    let missing = false;
    if (item.type === 'distance') {
      const trips = Number(item.trips) || 1;
      if (Number(distanceKm) > 0) {
        const km = Number(distanceKm) * trips;
        amountPln = toPln(km * (Number(item.ratePerKm) || 0), item.currency || 'CHF');
        note = `${Math.round(km)} km × ${item.ratePerKm} ${item.currency || 'CHF'}`;
      } else {
        missing = true;
        note = 'brak odległości – uzupełnij adres sprzedającego i garażu';
      }
    } else if (item.type === 'fixed') {
      amountPln = toPln(Number(item.amount) || 0, item.currency || 'PLN');
    } else if (item.type === 'percent') {
      const base = item.base === 'price' ? pricePln : running;
      amountPln = (base * (Number(item.pct) || 0)) / 100;
    }
    running += amountPln;
    items.push({ name: item.name, amountPln: round(amountPln), ...(note ? { note } : {}), ...(missing ? { missing } : {}) });
  }
  return { pricePln: round(pricePln), totalPln: round(running), items };
}

/**
 * Ocena okazji: porównanie łącznego kosztu do wartości rynkowej w PL.
 * Zwraca też maksymalną stawkę (w walucie aukcji), przy której okazja jest wciąż spełniona.
 */
function evaluateDeal({ price, currency, engineCc, distanceKm, costs, rates, marketValuePln, thresholdPct }) {
  const calc = calculateTotal(price, { currency, engineCc, distanceKm, costs, rates });
  const result = { ...calc, marketValuePln: marketValuePln ? round(marketValuePln) : null };
  if (!marketValuePln) return { ...result, discountPct: null, isDeal: false, maxBid: null };

  const discountPct = ((marketValuePln - calc.totalPln) / marketValuePln) * 100;

  // Koszt jest liniową funkcją ceny: total = a * price + b
  const t0 = calculateTotal(0, { currency, engineCc, distanceKm, costs, rates }).totalPln;
  const t1 = calculateTotal(1000, { currency, engineCc, distanceKm, costs, rates }).totalPln;
  const a = (t1 - t0) / 1000;
  const target = marketValuePln * (1 - thresholdPct / 100);
  const maxBid = a > 0 ? Math.floor((target - t0) / a) : null;

  return {
    ...result,
    discountPct: Math.round(discountPct * 10) / 10,
    isDeal: discountPct >= thresholdPct,
    maxBid: maxBid != null && maxBid > 0 ? maxBid : 0,
  };
}

function round(n) {
  return Math.round(n);
}

module.exports = { calculateTotal, evaluateDeal, conditionMet };
