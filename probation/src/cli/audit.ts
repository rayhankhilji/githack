// audit — converts `npm audit --json` for the app into a GitLab-format report the gate can diff.
import { execFileSync } from 'node:child_process';
import { main, writeOut } from './common.ts';

interface NpmAuditVuln {
  name: string;
  severity: string;
  range: string;
  via: (string | { source: number; title: string; url: string })[];
}

export function toGitLabReport(audit: { vulnerabilities?: Record<string, NpmAuditVuln> }) {
  const vulnerabilities = Object.values(audit.vulnerabilities ?? {}).flatMap((v) =>
    v.via
      .filter((via): via is Exclude<typeof via, string> => typeof via !== 'string')
      .map((via) => ({
        name: via.title,
        severity: v.severity[0].toUpperCase() + v.severity.slice(1),
        location: {
          file: 'app/package-lock.json',
          dependency: { package: { name: v.name }, version: v.range },
        },
        identifiers: [{ type: 'npm', value: String(via.source) }],
      })),
  );
  return { version: '15.0.0', vulnerabilities };
}

main(async () => {
  let raw: string;
  try {
    raw = execFileSync('npm', ['audit', '--json', '--prefix', 'app'], { encoding: 'utf8' });
  } catch (error) {
    raw = (error as { stdout?: string }).stdout ?? '{}'; // npm audit exits 1 when it finds anything
  }
  const report = toGitLabReport(JSON.parse(raw));
  writeOut('gl-npm-audit-report.json', JSON.stringify(report, null, 2));
  console.log(`npm audit: ${report.vulnerabilities.length} finding(s)`);
});
