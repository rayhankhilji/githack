import picomatch from 'picomatch';
import type { Policy, Zone } from './policy.ts';

export const UNZONED = 'unzoned';

export function zoneFor(policy: Policy, file: string): Zone | undefined {
  return policy.zones.find((zone) => zone.globs.some((glob) => picomatch.isMatch(file, glob, { dot: true })));
}

export interface ZonedChange {
  zones: string[];
  forbidden: { file: string; zone: string }[];
  neutral: string[];
  unzoned: string[];
}

export function classifyChanges(policy: Policy, files: string[]): ZonedChange {
  const zones = new Set<string>();
  const forbidden: ZonedChange['forbidden'] = [];
  const unzoned: string[] = [];
  const neutral: string[] = [];
  for (const file of files) {
    const zone = zoneFor(policy, file);
    if (!zone) {
      unzoned.push(file);
      continue;
    }
    if (zone.forbidden) forbidden.push({ file, zone: zone.name });
    else if (zone.neutral) neutral.push(file);
    else zones.add(zone.name);
  }
  return { zones: [...zones].sort(), forbidden, neutral, unzoned };
}
