// soak — monitor stage. Hammers the canary revision with synthetic checks for N minutes.
// One failure means the deletion broke a real client: exit non-zero so rollback runs.
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { arg, main, writeOut } from './common.ts';

interface Synthetic {
  name: string;
  method: string;
  path: string;
}

export interface SoakResult {
  checks: number;
  failures: { name: string; path: string; status: number; at: string }[];
}

export async function soak(
  url: string,
  checks: Synthetic[],
  minutes: number,
  intervalMs = 15000,
  fetcher: typeof fetch = fetch,
) {
  const result: SoakResult = { checks: 0, failures: [] };
  const until = Date.now() + minutes * 60_000;
  do {
    for (const check of checks) {
      result.checks++;
      const res = await fetcher(`${url}${check.path}`, { method: check.method, redirect: 'manual' }).catch(
        () => undefined,
      );
      const status = res?.status ?? 0;
      if (status === 0 || status >= 400)
        result.failures.push({ name: check.name, path: check.path, status, at: new Date().toISOString() });
    }
    if (result.failures.length) break;
    if (Date.now() < until) await new Promise((r) => setTimeout(r, intervalMs));
  } while (Date.now() < until);
  return result;
}

main(async () => {
  const url = arg('url').replace(/\/$/, '');
  const minutes = Number(arg('minutes', '3'));
  const { checks } = parse(readFileSync('probation/synthetics.yml', 'utf8')) as { checks: Synthetic[] };
  console.log(`soak: ${checks.length} synthetics against ${url} for ${minutes} min`);
  const result = await soak(url, checks, minutes);
  writeOut('.out/soak.json', JSON.stringify(result, null, 2));
  if (result.failures.length) {
    throw new Error(
      `canary failed: ${result.failures.map((f) => `${f.name} ${f.path} → ${f.status}`).join(', ')}`,
    );
  }
  console.log(`soak: ${result.checks} checks, 0 failures`);
});
