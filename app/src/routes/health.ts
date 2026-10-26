import type { FastifyInstance } from 'fastify';

export async function healthRoutes(app: FastifyInstance) {
  app.get('/healthz', async () => ({ ok: true, revision: process.env.K_REVISION ?? 'local' }));
}
