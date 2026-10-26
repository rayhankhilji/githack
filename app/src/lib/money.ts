import type { Invoice } from '../store.ts';

export function formatMoney(amountCents: number, currency: Invoice['currency']): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amountCents / 100);
}

export function totalOutstanding(invoices: Invoice[]): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const invoice of invoices) {
    if (invoice.status === 'paid') continue;
    totals[invoice.currency] = (totals[invoice.currency] ?? 0) + invoice.amountCents;
  }
  return totals;
}

// Legacy: pre-2025 formatter kept "just in case". Nothing imports it.
export function formatMoneyLegacy(amountCents: number): string {
  return `$${(amountCents / 100).toFixed(2)}`;
}
