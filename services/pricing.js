'use strict';

// Pure price math in integer halalas. Prices are VAT-exclusive:
//   net   = subtotal - discount
//   vat   = round half up (net * rate)       (one rounding, on the whole order)
//   total = net + vat
// No floating point is used for money (percentages are basis points).

const billing = require('../config/billing');
const money = require('./money');

/** n / d rounded half up, for non-negative integers. */
function divRound(n, d) {
  return Math.floor((n * 2 + d) / (d * 2));
}

/** VAT on a net amount (halalas), rate in basis points. */
function vatOf(netHalalas, vatBp = billing.VAT_RATE_BP) {
  return divRound(netHalalas * vatBp, 10000);
}

/** A plan's VAT-exclusive price for an interval, in halalas. */
function planPrice(plan, interval) {
  return money.fromDecimal(interval === 'yearly' ? plan.price_yearly : plan.price_monthly);
}

/** What a plan brings in per month (MRR), in halalas: yearly prices are spread over 12 months. */
function monthlyEquivalent(plan, interval) {
  const price = planPrice(plan, interval);
  return interval === 'yearly' ? divRound(price, 12) : price;
}

/**
 * The discount of a promo on a subtotal. promo: { discount_type: 'percent',
 * percent_bp } or { discount_type: 'fixed', fixed_halalas }. Never more than
 * the subtotal, never negative.
 */
function discountOf(subtotal, promo) {
  if (!promo) return 0;
  const raw = promo.discount_type === 'percent' ? divRound(subtotal * Number(promo.percent_bp), 10000) : Number(promo.fixed_halalas);
  return Math.max(0, Math.min(subtotal, Number.isFinite(raw) ? raw : 0));
}

/** The full quote shown before payment. */
function quote({ price, promo = null, vatBp = billing.VAT_RATE_BP }) {
  const subtotal = Math.max(0, Math.round(price));
  const discount = discountOf(subtotal, promo);
  const net = subtotal - discount;
  const vat = vatOf(net, vatBp);
  return { subtotal, discount, net, vat, vatBp, total: net + vat };
}

module.exports = { divRound, vatOf, planPrice, monthlyEquivalent, discountOf, quote };
