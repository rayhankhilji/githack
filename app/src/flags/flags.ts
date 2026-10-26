// Feature flags, configured per Cloud Run revision through env vars (FLAG_<NAME>=on|off).
// Every evaluation is logged so the census can tell which flags are permanently on or off.

export const FLAG_DEFAULTS = {
  newTotals: true, // shipped 2025-03, has been on everywhere since
  legacyPdf: false, // PDF renderer that was replaced, never re-enabled
  holidayBanner2024: false, // seasonal banner from 2024
} as const;

export type FlagName = keyof typeof FLAG_DEFAULTS;

export type FlagRecorder = (flag: FlagName, value: boolean) => void;

export function readFlag(name: FlagName, env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[`FLAG_${name.replace(/[A-Z0-9]+/g, (m) => `_${m}`).toUpperCase()}`];
  if (raw === 'on') return true;
  if (raw === 'off') return false;
  return FLAG_DEFAULTS[name];
}

export function createFlags(record: FlagRecorder, env: NodeJS.ProcessEnv = process.env) {
  return (name: FlagName): boolean => {
    const value = readFlag(name, env);
    record(name, value);
    return value;
  };
}
