import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

export interface SciCoefficients {
  compute: { min_watts_per_vcpu: number; max_watts_per_vcpu: number };
  memory: { kwh_per_gb_hour: number };
  network: { kwh_per_gb: number };
  pue: number;
  grid: { region: string; grams_co2e_per_kwh: number };
  embodied: { grams_per_vcpu_hour: number };
  workload: { cold_starts_per_1k_requests: number };
}

export interface SciMeasurement {
  requests: number;
  cpuSeconds: number;
  avgRssMb: number;
  durationSeconds: number;
  deployableMb: number;
  coldStartMs: number;
}

export interface SciResult {
  gramsPer1kRequests: number;
  kwhPer1kRequests: number;
  breakdown: { computeG: number; memoryG: number; networkG: number; coldStartG: number; embodiedG: number };
  measurement: SciMeasurement;
  region: string;
}

export function loadCoefficients(path = 'probation/sci-coefficients.yml'): SciCoefficients {
  return parse(readFileSync(path, 'utf8')) as SciCoefficients;
}

// SCI = ((E * I) + M) / R. Everything is normalised to R = 1,000 requests.
export function computeSci(c: SciCoefficients, m: SciMeasurement): SciResult {
  const per1k = 1000 / m.requests;
  const cpuHours = (m.cpuSeconds / 3600) * per1k;
  const computeKwh = (cpuHours * c.compute.max_watts_per_vcpu) / 1000;
  const memoryKwh = (m.avgRssMb / 1024) * (m.durationSeconds / 3600) * per1k * c.memory.kwh_per_gb_hour;
  const networkKwh = (m.deployableMb / 1024) * c.network.kwh_per_gb * c.workload.cold_starts_per_1k_requests;
  // A cold start burns one vCPU at max watts for its duration.
  const coldStartKwh =
    ((m.coldStartMs / 1000 / 3600) * c.compute.max_watts_per_vcpu * c.workload.cold_starts_per_1k_requests) /
    1000;
  const toGrams = (kwh: number) => kwh * c.pue * c.grid.grams_co2e_per_kwh;
  const embodiedG =
    (cpuHours + (m.coldStartMs / 1000 / 3600) * c.workload.cold_starts_per_1k_requests) *
    c.embodied.grams_per_vcpu_hour;
  const breakdown = {
    computeG: toGrams(computeKwh),
    memoryG: toGrams(memoryKwh),
    networkG: toGrams(networkKwh),
    coldStartG: toGrams(coldStartKwh),
    embodiedG,
  };
  const total = Object.values(breakdown).reduce((a, b) => a + b, 0);
  return {
    gramsPer1kRequests: total,
    kwhPer1kRequests: (computeKwh + memoryKwh + networkKwh + coldStartKwh) * c.pue,
    breakdown,
    measurement: m,
    region: c.grid.region,
  };
}

export function pctChange(before: number, after: number): number {
  return before === 0 ? 0 : ((after - before) / before) * 100;
}

export function sciMarkdown(before: SciResult | undefined, after: SciResult): string {
  const fmt = (n: number) => n.toFixed(5);
  const row = (name: string, b: number | undefined, a: number) =>
    `| ${name} | ${b === undefined ? '—' : fmt(b)} | ${fmt(a)} | ${b === undefined ? '—' : `${pctChange(b, a).toFixed(1)}%`} |`;
  return [
    `**SCI** (gCO₂e per 1,000 requests, region \`${after.region}\`)`,
    '',
    '| Component | main | this MR | Δ |',
    '|---|---|---|---|',
    row('Compute', before?.breakdown.computeG, after.breakdown.computeG),
    row('Memory', before?.breakdown.memoryG, after.breakdown.memoryG),
    row('Image transfer', before?.breakdown.networkG, after.breakdown.networkG),
    row('Cold start', before?.breakdown.coldStartG, after.breakdown.coldStartG),
    row('Embodied', before?.breakdown.embodiedG, after.breakdown.embodiedG),
    row('**Total SCI**', before?.gramsPer1kRequests, after.gramsPer1kRequests),
    '',
    `Deployable size ${before ? `${before.measurement.deployableMb.toFixed(1)} → ` : ''}${after.measurement.deployableMb.toFixed(1)} MB · cold start ${before ? `${before.measurement.coldStartMs.toFixed(0)} → ` : ''}${after.measurement.coldStartMs.toFixed(0)} ms. Method: docs/SCI.md`,
  ].join('\n');
}
