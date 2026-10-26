import { type Level, levelForScore, type Policy, type ScoringEvent } from './policy.ts';
import type { SciResult } from './sci.ts';

// The ledger is the agent's permanent record: every scored event, append-only, plus derived scores.
export interface LedgerEvent {
  at: string;
  agent: string;
  zone: string;
  event: ScoringEvent;
  points: number;
  scoreAfter: number;
  levelBefore: Level;
  levelAfter: Level;
  ref: { mr?: number; sha?: string; pipeline?: number; url?: string };
  note?: string;
}

export interface Grave {
  at: string;
  mr?: number;
  title: string;
  zone: string;
  linesRemoved: number;
  sciDeltaPct?: number;
  status: 'buried' | 'exhumed';
}

export interface SecurityBaseline {
  at: string;
  sha: string;
  fingerprints: string[];
}

export interface Ledger {
  version: 1;
  scores: Record<string, Record<string, number>>;
  events: LedgerEvent[];
  graveyard: Grave[];
  security?: SecurityBaseline;
  sci?: { baseline?: SciResult; history: SciPoint[] };
}

export interface SciPoint {
  at: string;
  sha: string;
  gramsPer1kRequests: number;
  imageMb?: number;
}

export function emptyLedger(): Ledger {
  return { version: 1, scores: {}, events: [], graveyard: [], sci: { history: [] } };
}

export function scoreOf(ledger: Ledger, agent: string, zone: string): number {
  return ledger.scores[agent]?.[zone] ?? 0;
}

export function levelOf(ledger: Ledger, policy: Policy, agent: string, zone: string): Level {
  return levelForScore(policy, scoreOf(ledger, agent, zone));
}

export interface ScoreInput {
  agent: string;
  zones: string[];
  event: ScoringEvent;
  ref: LedgerEvent['ref'];
  note?: string;
  at?: string;
}

// Applies one scoring event to every zone the change touched. Returns the new ledger and the events written.
export function applyEvent(
  ledger: Ledger,
  policy: Policy,
  input: ScoreInput,
): { ledger: Ledger; written: LedgerEvent[] } {
  const next: Ledger = structuredClone(ledger);
  const written: LedgerEvent[] = [];
  const points = policy.scoring[input.event];
  for (const zone of input.zones) {
    const before = scoreOf(next, input.agent, zone);
    // Scores never go below zero: a demoted agent restarts at Assisted, it is not in debt forever.
    const after = Math.max(0, before + points);
    next.scores[input.agent] ??= {};
    next.scores[input.agent][zone] = after;
    const event: LedgerEvent = {
      at: input.at ?? new Date().toISOString(),
      agent: input.agent,
      zone,
      event: input.event,
      points,
      scoreAfter: after,
      levelBefore: levelForScore(policy, before),
      levelAfter: levelForScore(policy, after),
      ref: input.ref,
      note: input.note,
    };
    next.events.push(event);
    written.push(event);
  }
  return { ledger: next, written };
}

export function levelChanges(events: LedgerEvent[]): LedgerEvent[] {
  return events.filter((e) => e.levelBefore !== e.levelAfter);
}
