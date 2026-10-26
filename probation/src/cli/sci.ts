// sci — measures Software Carbon Intensity for the current tree and compares it to main's baseline.
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import autocannon from 'autocannon';
import { computeSci, loadCoefficients, type SciResult, sciMarkdown } from '../sci.ts';
import { env, gitlab, hasFlag, ledgerStore, main, writeOut } from './common.ts';

function procCpuSeconds(pid: number): number {
  const fields = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
  return (Number(fields[11]) + Number(fields[12])) / 100; // utime + stime, in clock ticks (USER_HZ = 100)
}

function procRssMb(pid: number): number {
  const line = readFileSync(`/proc/${pid}/status`, 'utf8')
    .split('\n')
    .find((l) => l.startsWith('VmRSS:'));
  return Number(line?.match(/\d+/)?.[0] ?? 0) / 1024;
}

async function waitHealthy(port: number, started: number): Promise<number> {
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (res.ok) return performance.now() - started;
    } catch {}
    if (performance.now() - started > 15000) throw new Error('app did not become healthy in 15s');
    await new Promise((r) => setTimeout(r, 20));
  }
}

export async function measure(durationSeconds = Number(env.SCI_DURATION ?? 10)) {
  const port = 18000 + Math.floor(Math.random() * 1000);
  const started = performance.now();
  const child = spawn('node', ['app/src/index.ts'], {
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  try {
    const coldStartMs = await waitHealthy(port, started);
    const cpuBefore = procCpuSeconds(child.pid!);
    const rss: number[] = [];
    const sampler = setInterval(() => rss.push(procRssMb(child.pid!)), 250);
    // Fixed, deterministic mix of the app's live endpoints.
    const result = await autocannon({
      url: `http://127.0.0.1:${port}`,
      connections: 10,
      duration: durationSeconds,
      requests: [
        { method: 'GET', path: '/api/invoices' },
        { method: 'GET', path: '/' },
        { method: 'GET', path: '/api/invoices/inv_1002' },
      ],
    });
    clearInterval(sampler);
    const cpuSeconds = procCpuSeconds(child.pid!) - cpuBefore;
    const deployableMb = Number(execFileSync('du', ['-sk', 'app']).toString().split('\t')[0]) / 1024;
    return {
      requests: result.requests.total,
      cpuSeconds,
      avgRssMb: rss.reduce((a, b) => a + b, 0) / Math.max(rss.length, 1),
      durationSeconds,
      deployableMb,
      coldStartMs,
    };
  } finally {
    child.kill('SIGTERM');
  }
}

main(async () => {
  const result: SciResult = computeSci(loadCoefficients(), await measure());
  writeOut('.out/sci.json', JSON.stringify(result, null, 2));
  const ledger =
    env.LEDGER_FILE || env.GITLAB_PROBATION_TOKEN
      ? await ledgerStore()
          .load()
          .catch(() => undefined)
      : undefined;
  const md = sciMarkdown(ledger?.sci?.baseline, result);
  writeOut('.out/sci.md', md);
  console.log(md);
  const iid = Number(env.CI_MERGE_REQUEST_IID);
  if (iid && !hasFlag('no-comment') && env.GITLAB_PROBATION_TOKEN) await gitlab().noteMr(iid, `🌱 ${md}`);
});
