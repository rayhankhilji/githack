// replay — verify stage. Every route that served real traffic in the census window must still exist.
// It only knows what the census saw. Clients slower than the window are caught later, by the canary soak.
import { existsSync, readFileSync } from 'node:fs';
import { buildServer } from '../../../app/src/server.ts';
import { LEDGER_BRANCH } from '../store.ts';
import { arg, env, gitlab, main } from './common.ts';

main(async () => {
  // Prefer the latest production census (ledger branch); fall back to the fixture for local runs.
  const live = env.GITLAB_PROBATION_TOKEN
    ? await gitlab()
        .getFile('traffic.json', LEDGER_BRANCH)
        .catch(() => undefined)
    : undefined;
  const trafficPath = arg(
    'traffic',
    existsSync('.out/traffic.json') ? '.out/traffic.json' : 'probation/fixtures/traffic.json',
  );
  const traffic = JSON.parse(live ?? readFileSync(trafficPath, 'utf8')) as Record<string, number>;
  console.log(`replay: traffic from ${live ? 'ledger branch (production census)' : trafficPath}`);
  const { app, routes } = buildServer({ censusLog: () => {} });
  await app.ready();
  const failures: string[] = [];

  for (const [route, hits] of Object.entries(traffic)) {
    // Fastify answers HEAD for every GET route implicitly, so HEAD traffic is covered by the GET check.
    if (route.startsWith('HEAD ')) continue;
    if (hits > 0 && !route.endsWith(' unmatched') && !routes.includes(route)) {
      failures.push(`deleted a live route: ${route} served ${hits} request(s) in the census window`);
    }
  }
  await app.close();
  console.log(`replay: ${Object.keys(traffic).length} observed routes`);
  if (failures.length) throw new Error(`\n  - ${failures.join('\n  - ')}`);
  console.log('replay: ok');
});
