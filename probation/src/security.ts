import { readFileSync } from 'node:fs';

// Reads GitLab security report artifacts (gl-sast-report.json, gl-dependency-scanning-report.json, ...).
export interface Finding {
  fingerprint: string;
  severity: string;
  name: string;
  file?: string;
}

interface ReportVulnerability {
  id?: string;
  name?: string;
  severity?: string;
  location?: { file?: string; dependency?: { package?: { name?: string }; version?: string } };
  identifiers?: { type: string; value: string }[];
}

export function parseReport(json: string): Finding[] {
  const report = JSON.parse(json) as { vulnerabilities?: ReportVulnerability[] };
  return (report.vulnerabilities ?? []).map((v) => {
    const ident = v.identifiers?.map((i) => `${i.type}:${i.value}`).sort()[0] ?? v.name ?? 'unknown';
    const dep = v.location?.dependency?.package?.name;
    const where = dep ? `${dep}@${v.location?.dependency?.version ?? ''}` : (v.location?.file ?? '');
    return {
      fingerprint: `${ident}|${where}`,
      severity: v.severity ?? 'Unknown',
      name: v.name ?? ident,
      file: v.location?.file,
    };
  });
}

export function readReports(paths: string[]): Finding[] {
  return paths.flatMap((p) => {
    try {
      return parseReport(readFileSync(p, 'utf8'));
    } catch {
      return [];
    }
  });
}

export function diffFindings(baseline: string[] | undefined, current: Finding[]) {
  const base = new Set(baseline ?? []);
  const now = new Set(current.map((f) => f.fingerprint));
  return {
    introduced: current.filter((f) => !base.has(f.fingerprint)),
    removed: [...base].filter((fp) => !now.has(fp)),
  };
}
