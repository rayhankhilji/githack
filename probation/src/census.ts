import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export interface CensusLine {
  method: string;
  route: string;
  status: number;
  flags?: Record<string, boolean>;
}

export type CandidateKind = 'route' | 'flag' | 'dependency' | 'export';

export interface Candidate {
  key: string;
  kind: CandidateKind;
  title: string;
  file?: string;
  evidence: string;
}

export interface CensusStats {
  requests: number;
  routeHits: Record<string, number>;
  flagValues: Record<string, { on: number; off: number }>;
}

// Accepts `gcloud logging read --format=json` output (array of entries with jsonPayload) or JSONL of census lines.
export function parseCensusLog(text: string): CensusLine[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const records: unknown[] = trimmed.startsWith('[')
    ? JSON.parse(trimmed)
    : trimmed
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l));
  return records
    .map((r) => ((r as { jsonPayload?: unknown }).jsonPayload ?? r) as CensusLine & { census?: number })
    .filter((r) => r.census === 1 || (r.method && r.route));
}

export function aggregate(lines: CensusLine[]): CensusStats {
  const stats: CensusStats = { requests: 0, routeHits: {}, flagValues: {} };
  for (const line of lines) {
    stats.requests++;
    const key = `${line.method} ${line.route}`;
    stats.routeHits[key] = (stats.routeHits[key] ?? 0) + 1;
    for (const [flag, value] of Object.entries(line.flags ?? {})) {
      stats.flagValues[flag] ??= { on: 0, off: 0 };
      stats.flagValues[flag][value ? 'on' : 'off']++;
    }
  }
  return stats;
}

export interface SourceFile {
  path: string;
  text: string;
}

export function readSources(dir: string, root = process.cwd()): SourceFile[] {
  const out: SourceFile[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.ts')) out.push({ path: relative(root, p), text: readFileSync(p, 'utf8') });
    }
  };
  walk(dir);
  return out;
}

export interface FindInput {
  stats: CensusStats;
  routes: string[];
  flags: string[];
  dependencies: string[];
  sources: SourceFile[];
  windowDays: number;
  minRequests: number;
  exclude: Set<string>;
  keep?: string[];
}

export function findCandidates(input: FindInput): Candidate[] {
  const { stats, sources } = input;
  const out: Candidate[] = [];
  const window = `${input.windowDays}d`;
  const enoughTraffic = stats.requests >= input.minRequests;

  if (enoughTraffic) {
    for (const route of input.routes) {
      if (input.keep?.includes(route) || (stats.routeHits[route] ?? 0) > 0) continue;
      const path = route.split(' ')[1];
      const file = sources.find((s) => s.text.includes(`'${path}'`))?.path;
      out.push({
        key: `route:${route}`,
        kind: 'route',
        title: `${route} has 0 requests in ${window}`,
        file,
        evidence: `0 of ${stats.requests} requests in the last ${window} matched \`${route}\`.`,
      });
    }
    for (const flag of input.flags) {
      const seen = stats.flagValues[flag];
      if (seen && seen.on > 0 && seen.off > 0) continue;
      const value = !seen
        ? 'never evaluated'
        : seen.on > 0
          ? `always on (${seen.on} evaluations)`
          : `always off (${seen.off} evaluations)`;
      out.push({
        key: `flag:${flag}`,
        kind: 'flag',
        title: `Flag \`${flag}\` is ${value.split(' (')[0]} in ${window}`,
        file: sources.find((s) => s.path.includes('flags'))?.path,
        evidence: `\`${flag}\` was ${value} across ${stats.requests} requests in the last ${window}. Inline the live branch and delete the flag.`,
      });
    }
  }

  const imports = sources.map((s) => s.text).join('\n');
  for (const dep of input.dependencies) {
    if (new RegExp(`from '${dep}(/[^']*)?'`).test(imports)) continue;
    out.push({
      key: `dependency:${dep}`,
      kind: 'dependency',
      title: `Dependency \`${dep}\` is never imported`,
      file: 'app/package.json',
      evidence: `No file under app/src imports \`${dep}\`. It still ships in the image.`,
    });
  }

  for (const source of sources) {
    for (const match of source.text.matchAll(/export function (\w+)/g)) {
      const name = match[1];
      // Used if it appears anywhere besides its own definition (other modules or the same file).
      const refs = sources.reduce(
        (n, s) => n + (s.text.match(new RegExp(`\\b${name}\\b`, 'g'))?.length ?? 0),
        0,
      );
      const used = refs > 1;
      if (used) continue;
      out.push({
        key: `export:${source.path}#${name}`,
        kind: 'export',
        title: `\`${name}\` in ${source.path} is exported but never imported`,
        file: source.path,
        evidence: `No other module references \`${name}\`.`,
      });
    }
  }
  return out.filter((c) => !input.exclude.has(c.key));
}
