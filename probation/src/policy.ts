import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

export type Level = 'assisted' | 'supervised' | 'hands_off';
export type ScoringEvent = 'survived_soak' | 'rolled_back' | 'human_rejected' | 'security_finding';

export interface Zone {
  name: string;
  globs: string[];
  forbidden?: boolean;
  neutral?: boolean;
}

export interface Policy {
  agents: Record<string, { label: string; author_pattern: string }>;
  levels: Record<Level, number>;
  scoring: Record<ScoringEvent, number>;
  zones: Zone[];
  soak: { minutes: number; canary_percent: number; max_5xx_rate: number; synthetics: string };
  census: { window_days: number; min_requests_in_window: number; keep?: string[]; stale_hours?: number };
}

export const LEVEL_ORDER: Level[] = ['assisted', 'supervised', 'hands_off'];

export function loadPolicy(path = 'probation/policy.yml'): Policy {
  return parsePolicy(readFileSync(path, 'utf8'));
}

export function parsePolicy(text: string): Policy {
  const policy = parse(text) as Policy;
  const { assisted, supervised, hands_off } = policy.levels;
  if (!(assisted <= supervised && supervised <= hands_off)) {
    throw new Error('policy.levels must be ascending: assisted <= supervised <= hands_off');
  }
  if (!policy.zones?.length) throw new Error('policy.zones must not be empty');
  return policy;
}

export function levelForScore(policy: Policy, score: number): Level {
  if (score >= policy.levels.hands_off) return 'hands_off';
  if (score >= policy.levels.supervised) return 'supervised';
  return 'assisted';
}

export function minLevel(levels: Level[]): Level {
  return levels.reduce<Level>(
    (low, l) => (LEVEL_ORDER.indexOf(l) < LEVEL_ORDER.indexOf(low) ? l : low),
    'hands_off',
  );
}
