/**
 * Stripe expects amounts in the currency's smallest unit. Most currencies have
 * 2 decimals (USD cents), but some have none (JPY, KRW...). Multiplying a JPY
 * amount by 100 would charge the customer 100x the invoice, so the conversion
 * must be currency-aware. Used both when creating the Checkout Session and when
 * verifying the amount Stripe reports back in the webhook.
 */
const ZERO_DECIMAL_CURRENCIES = new Set([
  'bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg', 'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf',
]);

export function toMinorUnits(amount: number, currency: string): number {
  if (ZERO_DECIMAL_CURRENCIES.has(currency.toLowerCase())) return Math.round(amount);
  return Math.round(amount * 100);
}
