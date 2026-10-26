export type InvoiceStatus = 'draft' | 'sent' | 'paid';

export interface Invoice {
  id: string;
  customer: string;
  amountCents: number;
  currency: 'USD' | 'EUR' | 'GBP';
  status: InvoiceStatus;
  issuedAt: string;
}

const seed: Invoice[] = [
  {
    id: 'inv_1001',
    customer: 'Northwind Bakery',
    amountCents: 125000,
    currency: 'USD',
    status: 'paid',
    issuedAt: '2026-09-02',
  },
  {
    id: 'inv_1002',
    customer: 'Kestrel Studio',
    amountCents: 48000,
    currency: 'EUR',
    status: 'sent',
    issuedAt: '2026-09-18',
  },
  {
    id: 'inv_1003',
    customer: 'Harbor & Pine',
    amountCents: 310050,
    currency: 'GBP',
    status: 'sent',
    issuedAt: '2026-10-01',
  },
  {
    id: 'inv_1004',
    customer: 'Quill Labs',
    amountCents: 9900,
    currency: 'USD',
    status: 'draft',
    issuedAt: '2026-10-20',
  },
];

export class InvoiceStore {
  private invoices = new Map<string, Invoice>();
  private nextId = 1005;

  constructor(initial: Invoice[] = seed) {
    for (const invoice of initial) this.invoices.set(invoice.id, { ...invoice });
  }

  list(): Invoice[] {
    return [...this.invoices.values()].sort((a, b) => b.issuedAt.localeCompare(a.issuedAt));
  }

  get(id: string): Invoice | undefined {
    return this.invoices.get(id);
  }

  create(input: Pick<Invoice, 'customer' | 'amountCents' | 'currency'>): Invoice {
    const invoice: Invoice = {
      ...input,
      id: `inv_${this.nextId++}`,
      status: 'draft',
      issuedAt: new Date().toISOString().slice(0, 10),
    };
    this.invoices.set(invoice.id, invoice);
    return invoice;
  }

  markPaid(id: string): Invoice | undefined {
    const invoice = this.invoices.get(id);
    if (invoice) invoice.status = 'paid';
    return invoice;
  }
}
