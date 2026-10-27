import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { beforeAll, describe, expect, it } from 'vitest';
import { decide, type GateInput } from '../src/gate.ts';
import { emptyLedger, type Ledger } from '../src/ledger.ts';
import { gateComment } from '../src/mr.ts';
import {
  BUNDLE_GLOBAL,
  buildGateBundle,
  inlineScript,
  type PlaygroundPreset,
  PRESETS,
  renderPlayground,
  repoFiles,
} from '../src/playground.ts';
import { ledgerWith, policy } from './helpers.ts';

type Gate = { decide: typeof decide; gateComment: typeof gateComment };

let bundle = '';
let gate: Gate;
beforeAll(async () => {
  bundle = await buildGateBundle();
  // Evaluate the exact bundle the page inlines, in a bare context with no Node globals (no require, no process).
  const sandbox: Record<string, unknown> = {};
  sandbox.window = sandbox;
  runInNewContext(`${inlineScript(bundle)};window.${BUNDLE_GLOBAL}=${BUNDLE_GLOBAL};`, sandbox);
  gate = sandbox[BUNDLE_GLOBAL] as Gate;
}, 30_000);

const current = ledgerWith({ legacy: 10 });

// What the page does for a preset: the preset's scores laid over the current ledger, then the gate input.
function presetCase(p: PlaygroundPreset, ledger: Ledger): { ledger: Ledger; input: GateInput } {
  const scores = { ...(ledger.scores.undertaker ?? {}), ...(p.scores ?? {}) };
  return {
    ledger: { ...emptyLedger(), scores: { undertaker: scores } },
    input: {
      agent: 'undertaker',
      files: p.files,
      introducedFindings: p.finding ? [{ fingerprint: 'playground', severity: 'High', name: 'x' }] : [],
      checksPassed: p.checksPassed !== false,
      coronerObjection: p.coroner ? 'see the coroner note on this MR' : undefined,
    },
  };
}

const render = (ledger: Ledger = current, files = ['app/src/legacy/fax.ts']) =>
  renderPlayground(policy, ledger, files, '2026-10-27T10:00:00.000Z', bundle);

describe('playground', () => {
  it('bundles the real gate for the browser with no Node imports', () => {
    expect(bundle.length).toBeGreaterThan(5_000);
    expect(bundle.length).toBeLessThan(80_000);
    expect(bundle).not.toMatch(/\brequire\(|node:fs|readFileSync\(/);
    expect(typeof gate.decide).toBe('function');
  });

  it.each(PRESETS.map((p) => [p.id, p] as const))(
    'preset %s: the bundle decides exactly like gate.ts',
    (_, p) => {
      for (const ledger of [current, emptyLedger()]) {
        const c = presetCase(p, ledger);
        const inBrowser = gate.decide(policy, c.ledger, c.input);
        const inCi = decide(policy, c.ledger, c.input);
        expect(JSON.parse(JSON.stringify(inBrowser))).toEqual(JSON.parse(JSON.stringify(inCi)));
        expect(gate.gateComment(inBrowser, 0)).toBe(gateComment(inCi, 0));
      }
    },
  );

  it('the presets tell the story: supervised fax, blocked auth/policy/test/growth, hands-off legacy', () => {
    const verdicts = Object.fromEntries(
      PRESETS.map((p) => {
        const c = presetCase(p, current);
        return [p.id, decide(policy, c.ledger, c.input).verdict];
      }),
    );
    expect(verdicts).toEqual({
      fax: 'merge_supervised',
      auth: 'block',
      policy: 'block',
      test: 'block',
      handsoff: 'merge_hands_off',
      grow: 'block',
    });
  });

  it('embeds escaped JSON: a path with </script> cannot break out', () => {
    const evil = 'app/src/legacy/</script><script>alert(1)</script><!--.ts';
    const html = render(ledgerWith({ '</script>': 5 }), [evil]);
    const data = html.match(/<script type="application\/json" id="pg-data">([\s\S]*?)<\/script>/)![1];
    expect(data).not.toMatch(/[<>]/);
    expect(JSON.parse(data).scores['</script>']).toBe(5);
    expect(JSON.parse(data).policy.zones.length).toBe(policy.zones.length);
    expect(html).not.toContain('<script>alert(1)');
    expect(html).toContain('&#60;/script&#62;&#60;script&#62;alert(1)');
    // Exactly three script blocks: data, bundle, page script.
    expect(html.match(/<script\b/g)).toHaveLength(3);
    expect(html.match(/<\/script>/g)).toHaveLength(3);
  });

  it('inlines a bundle safely', () => {
    expect(inlineScript('x="</script>"')).toBe('x="<\\/script>"');
    expect(() => inlineScript('x="<!--"')).toThrow(/cannot be inlined/);
  });

  it('renders the empty state with no files and an empty ledger', () => {
    const html = render(emptyLedger(), []);
    expect(html).toContain('No repository file list was embedded; type any path.');
    expect(html).toContain('No files in this merge request yet.');
    expect(html).toContain('No files yet.');
    expect(html).toContain('<datalist id="repo-files"></datalist>');
  });

  it('links back to the board and the replay, and announces the verdict', () => {
    const html = render();
    expect(html).toContain('href="index.html"');
    expect(html).toContain('href="replay.html"');
    expect(html).toContain('role="status" aria-live="polite"');
    expect(html).toContain('<option value="app/src/legacy/fax.ts">');
    expect(html).not.toContain('innerHTML');
  });

  it('names every per-file control by its file, and shows focus on every focusable element', () => {
    const html = render();
    // Each row's "file deleted" checkbox carries its path (screen-reader only), like the row's other controls.
    expect(html).toContain("document.createTextNode('file deleted'), el('span', 'sr', ' \\u2014 ' + f.path)");
    expect(html).toContain("'Lines ' + key + ' in ' + f.path");
    expect(html).toContain("'Remove ' + f.path");
    // The MR note is focusable (tabindex="0") so keyboard users can scroll it; it gets the same ring as buttons.
    for (const sel of ['button', 'input', 'a', 'pre', 'summary'])
      expect(html).toMatch(new RegExp(`${sel}:focus-visible[^{]*\\{outline:2px solid var\\(--ink\\)`));
    expect(html).toContain('<pre id="note" aria-labelledby="note-h" tabindex="0">');
  });

  it('lists the repo tree, from git or by walking the directory', () => {
    expect(repoFiles()).toContain('probation/policy.yml');
    const dir = mkdtempSync(join(tmpdir(), 'pg-'));
    mkdirSync(join(dir, 'src'));
    mkdirSync(join(dir, 'node_modules'));
    writeFileSync(join(dir, 'src', 'a.ts'), '');
    writeFileSync(join(dir, 'node_modules', 'b.js'), '');
    expect(repoFiles(dir)).toEqual(['src/a.ts']);
  });
});
