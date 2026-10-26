// soak-signal — the canary's own traffic as a verdict, next to the synthetics. Reads census lines that
// Cloud Logging recorded for the canary revision during the soak (and for the previous revision over the
// same window, as a baseline) and fails the release on a 5xx spike or on traffic to routes that vanished.
import type { CensusLine } from './census.ts';

// Below this many canary requests a 5xx rate is noise (1 error in 5 requests is 20%), so it is not judged.
export const MIN_SIGNAL_REQUESTS = 20;

export interface SoakSignal {
  requests: number;
  errors5xx: number;
  rate: number;
  /** Canary 404s that matched no route. */
  unmatched: number;
  /** How many unmatched 404s the baseline's own rate explains for this many canary requests. */
  unmatchedAllowed: number;
  baselineRequests: number;
  baselineUnmatched: number;
  /** Unmatched 404s beyond what the baseline explains: requests for routes this release deleted. */
  deletedRouteHits: number;
  verdict: 'pass' | 'fail';
  reasons: string[];
}

const isUnmatched = (l: CensusLine) => l.status === 404 && l.route === 'unmatched';

const pct = (n: number) => `${(n * 100).toFixed(2)}%`;

// Deleted-route rule. Census lines never carry the raw path (no URLs in logs), only the matched route or
// `unmatched`, so a 404 cannot be tied to a specific deleted route. But during the canary both revisions
// serve a random split of the same clients at the same time: paths that 404 on both (scanners, typos) are
// unmatched at the same rate on each. A path whose route this release deleted 404s only on the canary.
// So the canary's unmatched 404s in excess of the previous revision's rate (plus a 3σ Poisson allowance
// for noise) are hits on deleted routes, and any such hit fails the soak: a real client lost its endpoint.
// With no baseline traffic (first deploy) only the noise floor (3 unmatched 404s) is excused.
export function soakSignal(
  canary: CensusLine[],
  baseline: CensusLine[],
  max5xxRate: number,
  minRequests = MIN_SIGNAL_REQUESTS,
): SoakSignal {
  const requests = canary.length;
  const errors5xx = canary.filter((l) => l.status >= 500).length;
  const rate = requests ? errors5xx / requests : 0;
  const unmatched = canary.filter(isUnmatched).length;
  const baselineRequests = baseline.length;
  const baselineUnmatched = baseline.filter(isUnmatched).length;
  const expected = baselineRequests ? (baselineUnmatched / baselineRequests) * requests : 0;
  // 3σ allowance with a floor of σ = 1: a browser's /favicon.ico or one stray scanner hit during a quiet soak
  // must not roll back a good release. Real deleted-route use is caught by the synthetics either way.
  const unmatchedAllowed = Math.ceil(expected + 3 * Math.sqrt(Math.max(expected, 1)));
  const deletedRouteHits = Math.max(0, unmatched - unmatchedAllowed);

  const reasons: string[] = [];
  let fail = false;
  if (requests < minRequests) {
    reasons.push(`too few requests to judge the 5xx rate (${requests} < ${minRequests})`);
  } else if (rate > max5xxRate) {
    fail = true;
    reasons.push(`5xx rate ${pct(rate)} (${errors5xx}/${requests}) is above the ${pct(max5xxRate)} limit`);
  } else {
    reasons.push(`5xx rate ${pct(rate)} (${errors5xx}/${requests}) is within the ${pct(max5xxRate)} limit`);
  }
  if (deletedRouteHits > 0) {
    fail = true;
    reasons.push(
      `${deletedRouteHits} request(s) hit a route that no longer exists (${unmatched} unmatched 404s on the canary, ${unmatchedAllowed} explained by the previous revision's ${baselineUnmatched}/${baselineRequests})`,
    );
  } else if (unmatched > 0) {
    reasons.push(
      `${unmatched} unmatched 404(s), within what the previous revision saw (${baselineUnmatched}/${baselineRequests})`,
    );
  }
  return {
    requests,
    errors5xx,
    rate,
    unmatched,
    unmatchedAllowed,
    baselineRequests,
    baselineUnmatched,
    deletedRouteHits,
    verdict: fail ? 'fail' : 'pass',
    reasons,
  };
}

export function signalSummary(s: SoakSignal, revision?: string): string {
  return [
    `soak signal${revision ? ` for ${revision}` : ''}: ${s.verdict.toUpperCase()}`,
    `  canary: ${s.requests} requests, ${s.errors5xx} 5xx, ${s.unmatched} unmatched 404`,
    `  baseline: ${s.baselineRequests} requests, ${s.baselineUnmatched} unmatched 404`,
    ...s.reasons.map((r) => `  - ${r}`),
  ].join('\n');
}
