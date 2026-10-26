// soak — monitor stage. Hammers the canary revision with synthetic checks for N minutes.
// One failure means the deletion broke a real client: exit non-zero so rollback runs.
// `--signal <canary-log.json> [--baseline <log.json>]` instead judges the canary's real traffic from Cloud
// Logging (5xx rate, hits on deleted routes; see soak-signal.ts). A missing log file exits 3, which the
// child pipeline allows as a warning: a Cloud Logging outage must neither roll back nor score the agent.
import { existsSync, readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { parseCensusLog } from '../census.ts';
import { loadPolicy } from '../policy.ts';
import { signalSummary, soakSignal } from '../soak-signal.ts';
import { arg, env, hasFlag, main, writeOut } from './common.ts';

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

export const SIGNAL_UNAVAILABLE = 3;

function signal(): void {
  const logPath = arg('signal');
  const baselinePath = arg('baseline', '');
  if (!existsSync(logPath)) {
    console.log(`⚠ soak signal: ${logPath} is missing (soak:canary-logs failed?); judged on synthetics only`);
    process.exitCode = SIGNAL_UNAVAILABLE;
    return;
  }
  // Without the previous revision's view, scanner 404s can't be excused: warn rather than risk a false rollback.
  const hasPrevious = Boolean(env.PREVIOUS_REVISION) && env.PREVIOUS_REVISION !== env.REVISION;
  if (baselinePath && hasPrevious && !existsSync(baselinePath)) {
    console.log(
      `⚠ soak signal: ${baselinePath} is missing (baseline read failed?); judged on synthetics only`,
    );
    process.exitCode = SIGNAL_UNAVAILABLE;
    return;
  }
  const canary = parseCensusLog(readFileSync(logPath, 'utf8'));
  const baseline =
    baselinePath && existsSync(baselinePath) ? parseCensusLog(readFileSync(baselinePath, 'utf8')) : [];
  const result = soakSignal(canary, baseline, loadPolicy().soak.max_5xx_rate);
  writeOut('.out/soak-signal.json', JSON.stringify(result, null, 2));
  console.log(signalSummary(result, env.REVISION));
  if (result.verdict === 'fail') throw new Error(`canary signal failed: ${result.reasons.join('; ')}`);
}

main(async () => {
  if (hasFlag('signal')) return signal();
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
