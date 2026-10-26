import type { FastifyReply, FastifyRequest } from 'fastify';

// Writes require the shared API key. This zone is permanently off-limits to Undertaker (see probation/policy.yml).
export function requireApiKey(apiKey: string | undefined) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!apiKey) return;
    if (request.headers['x-api-key'] !== apiKey) {
      await reply
        .code(401)
        .send({ error: { code: 'unauthorized', message: 'Missing or invalid x-api-key' } });
    }
  };
}
