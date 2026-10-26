import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../server.ts';

// API v1, superseded by /api/invoices in 2025. Kept for "old integrations".
export async function legacyV1Routes(app: FastifyInstance, deps: AppDeps) {
  app.get('/api/v1/invoices', async () => ({
    data: deps.store
      .list()
      .map((i) => ({ invoice_id: i.id, client: i.customer, total: i.amountCents / 100 })),
  }));

  // Monthly accounting export. Still called on the 1st of every month by the bookkeeping partner.
  app.get('/api/v1/export.csv', async (_request, reply) => {
    const lines = deps.store
      .list()
      .map((i) => `${i.id},${JSON.stringify(i.customer)},${i.amountCents},${i.currency},${i.status}`);
    return reply.type('text/csv').send(['id,customer,amount_cents,currency,status', ...lines].join('\n'));
  });

  app.post('/api/v1/sync', async () => ({ synced: 0, note: 'v1 sync is a no-op since the 2025 migration' }));
}
