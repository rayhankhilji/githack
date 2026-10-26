import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../server.ts';
import { faxRoutes } from './fax.ts';
import { legacyV1Routes } from './v1.ts';

// Everything pre-2025 lives behind this one registration point.
export async function legacyRoutes(app: FastifyInstance, deps: AppDeps) {
  await app.register(faxRoutes);
  await app.register(legacyV1Routes, deps);
}
