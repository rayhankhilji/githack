import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/cli/common.ts', async (orig) => ({ ...(await orig<object>()), main: () => {} }));
const { releasePipeline } = await import('../src/cli/release-plan.ts');

describe('release plan', () => {
  it('T-F05-AC1: Hands-off ships to production without a manual gate', () => {
    const p = releasePipeline(
      { level: 'hands_off', agent: 'undertaker', mrIid: 7, zones: ['legacy'] },
      3,
      10,
    ) as Record<string, { when?: string }>;
    expect(p['approve:production'].when).toBe('on_success');
    expect(p['settle:survived']).toBeDefined();
  });

  it('T-F05-AC2: Supervised waits for a human before production', () => {
    const p = releasePipeline(
      { level: 'supervised', agent: 'undertaker', mrIid: 7, zones: ['legacy'] },
      3,
      10,
    ) as Record<string, { when?: string }>;
    expect(p['approve:production'].when).toBe('manual');
  });

  it('T-F05-AC3: human commits deploy but are never scored', () => {
    const p = releasePipeline({ level: 'human', zones: [] }, 3, 10) as Record<string, unknown>;
    expect(p['settle:survived']).toBeUndefined();
    expect(p['rollback:production']).toBeDefined();
  });
});

describe('release plan failure paths', () => {
  it('rolls back on any earlier failure and only scores a rollback after a failed soak', () => {
    const p = releasePipeline(
      { level: 'hands_off', agent: 'undertaker', mrIid: 7, zones: ['legacy'] },
      3,
      10,
    ) as Record<string, { when?: string; needs?: unknown[]; script?: string[]; stage?: string }>;
    expect(p['rollback:production'].when).toBe('on_failure');
    expect(p['rollback:production'].needs).toBeUndefined();
    expect(p['rollback:production'].script?.[0]).toContain('PREVIOUS_REVISION');
    expect(p['settle:rolled-back']).toMatchObject({
      when: 'on_failure',
      needs: ['rollback:production', 'soak:canary', 'soak:canary-signal'],
    });
    // A failed log read is not the agent's fault: it is neither in settle's needs nor able to fail the soak.
    expect(p['settle:rolled-back'].needs).not.toContain('soak:canary-logs');
    expect(p['settle:survived'].needs).toContainEqual({
      pipeline: '$PARENT_PIPELINE_ID',
      job: 'measure:sci',
    });
  });
});

describe('release plan canary signal', () => {
  type Job = {
    stage?: string;
    image?: string;
    needs?: unknown[];
    when?: string;
    allow_failure?: unknown;
    script?: string[];
    before_script?: string[];
    id_tokens?: unknown;
    artifacts?: { paths?: string[] };
  };
  const p = releasePipeline(
    { level: 'hands_off', agent: 'undertaker', mrIid: 7, zones: ['legacy'] },
    3,
    10,
  ) as Record<string, Job> & { stages: string[] };

  it('collects canary and baseline census lines from Cloud Logging after the soak window', () => {
    const logs = p['soak:canary-logs'];
    expect(logs).toMatchObject({
      stage: 'soak',
      image: 'google/cloud-sdk:slim',
      needs: ['deploy:staging', 'deploy:canary'],
      allow_failure: true,
      before_script: p['deploy:canary'].before_script,
      id_tokens: p['deploy:canary'].id_tokens,
    });
    const script = logs.script?.join('\n') ?? '';
    expect(script).toContain('sleep $(( SOAK_MINUTES * 60 + 60 ))');
    expect(script).toContain('gcloud logging read');
    expect(script).toContain('resource.labels.revision_name=\\"$1\\"');
    expect(script).toContain('jsonPayload.census=1');
    expect(script).toContain('--freshness=');
    expect(script).toContain('read_census "$REVISION" > .out/canary-log.json');
    expect(logs.artifacts?.paths).toContain('.out/canary-log.json');
  });

  it('evaluates the logs in the soak stage, so a failing signal skips promote and triggers rollback', () => {
    const signal = p['soak:canary-signal'];
    expect(signal).toMatchObject({
      stage: 'soak',
      needs: ['deploy:staging', 'soak:canary-logs'],
      allow_failure: { exit_codes: [3] },
    });
    expect(signal.script?.at(-1)).toContain('soak.ts --signal .out/canary-log.json');
    expect(p.stages.indexOf('soak')).toBeLessThan(p.stages.indexOf('promote'));
    expect(p['promote:production'].when).toBeUndefined();
    expect(p['rollback:production'].when).toBe('on_failure');
  });

  it('humans get the signal too, without settle jobs', () => {
    const h = releasePipeline({ level: 'human', zones: [] }, 3, 10) as Record<string, unknown>;
    expect(h['soak:canary-signal']).toBeDefined();
    expect(h['settle:rolled-back']).toBeUndefined();
  });
});

describe('release plan review fixes', () => {
  it('rolls back as soon as the synthetics fail, without waiting for the log read', () => {
    const p = releasePipeline(
      { level: 'hands_off', agent: 'undertaker', mrIid: 7, zones: ['legacy'] },
      3,
      10,
    ) as Record<string, { needs?: unknown[]; when?: string; script?: string[] }>;
    expect(p['rollback:soak']).toMatchObject({
      needs: ['deploy:staging', 'soak:canary'],
      when: 'on_failure',
    });
    expect(p['soak:canary-logs'].script?.join('\n')).toContain('canary-log.json.tmp && mv');
  });
});
