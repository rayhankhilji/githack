import { describe, expect, it } from 'vitest';
import { diffFindings, parseReport } from '../src/security.ts';

const report = (vulns: object[]) => JSON.stringify({ version: '15.0.0', vulnerabilities: vulns });
const lodashVuln = {
  name: 'Prototype Pollution in lodash',
  severity: 'High',
  location: {
    file: 'app/package-lock.json',
    dependency: { package: { name: 'lodash' }, version: '4.17.20' },
  },
  identifiers: [{ type: 'cve', value: 'CVE-2021-23337' }],
};

describe('security', () => {
  it('T-F02-AC3: fingerprints are stable and diffable', () => {
    const findings = parseReport(report([lodashVuln]));
    expect(findings[0].fingerprint).toBe('cve:CVE-2021-23337|lodash@4.17.20');
    const { introduced, removed } = diffFindings(['cve:CVE-2021-23337|lodash@4.17.20', 'old|x'], findings);
    expect(introduced).toEqual([]);
    expect(removed).toEqual(['old|x']);
  });
});
