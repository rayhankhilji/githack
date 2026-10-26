import type { FastifyInstance } from 'fastify';

// Fax gateway integration. The vendor shut down in 2024.
export async function faxRoutes(app: FastifyInstance) {
  app.post('/api/fax-invoice', async (_request, reply) =>
    reply
      .code(502)
      .send({ error: { code: 'fax_gateway_unavailable', message: 'Fax gateway is unreachable' } }),
  );
}
