import type { FastifyInstance } from 'fastify';
import { requireApiKey } from '../auth/apiKey.ts';
import { totalOutstanding } from '../lib/money.ts';
import type { AppDeps } from '../server.ts';

const createSchema = {
  body: {
    type: 'object',
    required: ['customer', 'amountCents', 'currency'],
    additionalProperties: false,
    properties: {
      customer: { type: 'string', minLength: 1, maxLength: 120 },
      amountCents: { type: 'integer', minimum: 1, maximum: 100_000_000 },
      currency: { type: 'string', enum: ['USD', 'EUR', 'GBP'] },
    },
  },
} as const;

export async function invoiceRoutes(app: FastifyInstance, deps: AppDeps) {
  const guard = requireApiKey(deps.apiKey);

  app.get('/api/invoices', async (request) => {
    const invoices = deps.store.list();
    const flag = request.flag;
    if (flag('newTotals')) {
      return { invoices, outstanding: totalOutstanding(invoices) };
    }
    // Old totals path: summed every currency together. Unreachable since newTotals shipped.
    const outstanding = invoices
      .filter((i) => i.status !== 'paid')
      .reduce((sum, i) => sum + i.amountCents, 0);
    return { invoices, outstanding: { ALL: outstanding } };
  });

  app.get<{ Params: { id: string } }>('/api/invoices/:id', async (request, reply) => {
    const invoice = deps.store.get(request.params.id);
    if (!invoice) return reply.code(404).send({ error: { code: 'not_found', message: 'Invoice not found' } });
    return invoice;
  });

  app.post<{ Body: { customer: string; amountCents: number; currency: 'USD' | 'EUR' | 'GBP' } }>(
    '/api/invoices',
    { schema: createSchema, preHandler: guard },
    async (request, reply) => reply.code(201).send(deps.store.create(request.body)),
  );

  app.post<{ Params: { id: string } }>(
    '/api/invoices/:id/pay',
    { preHandler: guard },
    async (request, reply) => {
      const invoice = deps.store.markPaid(request.params.id);
      if (!invoice)
        return reply.code(404).send({ error: { code: 'not_found', message: 'Invoice not found' } });
      return invoice;
    },
  );

  app.get<{ Params: { id: string } }>('/api/invoices/:id/pdf', async (request, reply) => {
    const invoice = deps.store.get(request.params.id);
    if (!invoice) return reply.code(404).send({ error: { code: 'not_found', message: 'Invoice not found' } });
    if (request.flag('legacyPdf')) {
      // Legacy PDF renderer, replaced by the print stylesheet. Flag has been off since 2025.
      return reply.type('application/pdf').send(Buffer.from(`%PDF-1.1 legacy ${invoice.id}`));
    }
    return reply.redirect(`/?print=${invoice.id}`);
  });
}
