import Fastify, { type FastifyInstance } from 'fastify';
import { createFlags, type FlagName } from './flags/flags.ts';
import { legacyRoutes } from './legacy/index.ts';
import { healthRoutes } from './routes/health.ts';
import { invoiceRoutes } from './routes/invoices.ts';
import { uiRoutes } from './routes/ui.ts';
import { InvoiceStore } from './store.ts';

export interface AppDeps {
  store: InvoiceStore;
  apiKey?: string;
}

export interface BuildOptions {
  apiKey?: string;
  env?: NodeJS.ProcessEnv;
  censusLog?: (line: CensusLine) => void;
}

// One structured line per request. Cloud Logging indexes jsonPayload.census; probation/src/cli/census.ts reads it.
export interface CensusLine {
  census: 1;
  method: string;
  route: string;
  status: number;
  flags: Partial<Record<FlagName, boolean>>;
}

declare module 'fastify' {
  interface FastifyRequest {
    flag: (name: FlagName) => boolean;
    flagsSeen: Partial<Record<FlagName, boolean>>;
  }
}

export function buildServer(options: BuildOptions = {}): { app: FastifyInstance; routes: string[] } {
  const app = Fastify({ logger: false });
  const deps: AppDeps = { store: new InvoiceStore(), apiKey: options.apiKey };
  const env = options.env ?? process.env;
  const censusLog =
    options.censusLog ?? ((line: CensusLine) => process.stdout.write(`${JSON.stringify(line)}\n`));
  const routes: string[] = [];

  app.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) if (method !== 'HEAD') routes.push(`${method} ${route.url}`);
  });

  app.decorateRequest('flag', () => false);
  app.decorateRequest('flagsSeen', null as unknown as Partial<Record<FlagName, boolean>>);
  app.addHook('onRequest', async (request) => {
    request.flagsSeen = {};
    request.flag = createFlags((name, value) => {
      request.flagsSeen[name] = value;
    }, env);
  });
  app.addHook('onResponse', async (request, reply) => {
    censusLog({
      census: 1,
      method: request.method,
      route: request.routeOptions.url ?? 'unmatched',
      status: reply.statusCode,
      flags: request.flagsSeen,
    });
  });

  app.register(healthRoutes);
  app.register(uiRoutes, deps);
  app.register(invoiceRoutes, deps);
  app.register(legacyRoutes, deps);

  return { app, routes };
}
