# Agent Instructions — Probation + Undertaker

> Version: 1.0 · Updated: 2026-10-26

## 0. Read Order

1. This file.
2. `docs/build/PRD.md` (what and why; feature IDs F-xx).
3. `docs/build/ARCHITECTURE.md` (contracts, data, deploy).
4. `docs/build/TASK_LOG.md` (where we are), then `docs/build/ROADMAP.md` (what's next).
5. Read only when relevant: `TESTING_GUIDE.md`, `EVAL_GUARDRAILS.md`, `DESIGN_SYSTEM.md`.

## 1. Mission

Ship a working, demoable post-code lifecycle where a deletion-only agent (Undertaker) earns autonomy through a deterministic CI gate (Probation). It is entered in the GitLab Transcend hackathon, **deadline 2026-10-27 13:00 UTC**. Working end-to-end beats feature-complete.

## 2. Operating Loop

1. Read the TASK_LOG Status. Pick the current task.
2. Read the referenced docs and code. Make the smallest change that satisfies the task.
3. Run `npm run check`, and the task's `verify:` command.
4. Update the TASK_LOG: tick the task, add a session line, and set the next action.
5. Commit with the message `<area>: <imperative summary>`. Never commit with failing checks.

## 3. Tech Stack (locked)

These are fixed; see ARCHITECTURE §2 for versions and rationale:
- Node 22.18+ running `.ts` directly;
- TypeScript strict with `erasableSyntaxOnly` (no enums, namespaces or parameter properties);
- Fastify 5.6, Vitest 3.2, Biome 2.2;
- `yaml`, `picomatch`, `autocannon`;
- GitLab CI, Duo flow registry v1;
- Cloud Run, Cloud Build, Artifact Registry, Cloud Logging, Secret Manager.

## 4. Repository Structure

```text
app/                    Tallybook (own package.json; Dockerfile builds from here)
  src/{routes,legacy,flags,lib,auth}/  server.ts  store.ts  index.ts
  test/                 app tests (Vitest)
probation/
  policy.yml            zones, thresholds, scoring (human-owned)
  synthetics.yml        soak checks
  sci-coefficients.yml  SCI coefficients
  src/                  libs: policy, zones, ledger, gate, census, dig, sci, security, mr, soak-signal, sweep,
                        board, replay, setup, demo, doccheck, gitlab, store
  src/cli/              CI entry points: gate, census, start-flow, replay, sci, audit, release-plan, soak, settle,
                        sweep, baseline, board, flow-print (+ common.ts helpers)
  sim/                  in-memory GitLab fake for the e2e tests
  test/                 Probation tests (test/e2e/ runs the real CLIs against sim/)
flows/undertaker.yml    AI Catalog item (flow definition)
agents/probation-clerk.yml  AI Catalog item (read-only Duo Chat agent)
mcp/                    read-only probation MCP server (stdio), wired in .gitlab/duo/mcp.json
ci/                     deploy.sh, gcp-auth.sh
infra/gcp-bootstrap.sh  one-time GCP setup
scripts/                gitlab-setup, doctor, demo, mock-flow, traffic, check-docs, render-media, record-replay,
                        audit-pages (.ts); push-to-gitlab.sh
docs/                   RUNBOOK, STAGES, SCI, DEMO_SCRIPT, SUBMISSION; build/ (these docs); media/
.gitlab-ci.yml  .gitlab/{CODEOWNERS,duo/agent-config.yml}
```

## 5. Commands

| Command | Does |
|---|---|
| `npm run setup` | Install the root and app dependencies (`npm ci` ×2) |
| `npm run dev` | Run Tallybook on :8080 |
| `npm run check` | Lint, typecheck and all tests |
| `npm run demo:mock` | Full Probation story offline → `.out/board.html` and `.out/replay.html` |
| `npm run gitlab:setup` / `npm run doctor` | Create the GitLab project setup / read-only preflight (needs `GITLAB_TOKEN`, `GITLAB_PROJECT`) |
| `npm run demo -- <status\|dig\|approve\|promote\|watch>` | Drive one live demo act (RUNBOOK §5) |
| `npm run mcp` | Start the read-only probation MCP server on stdio |
| `node scripts/check-docs.ts` | Check the Markdown docs against the code (also runs inside `npm test`) |
| `npm run replay` | Verify-stage traffic replay (fixture locally) |
| `npm run census -- --log <file> --dry-run` | Candidates from a log file, without GitLab |
| `npm run sci -- --no-comment` | Measure SCI locally (Linux, needs `/proc`) |
| `LEDGER_FILE=.out/mock-ledger.json npm run board -- --out .out/board.html` | Render the board from a local ledger |
| `npm run flow:print` | Print the flow definition to paste into GitLab |

## 6. Coding Standards

- **Types:**
  - strict, with no `any`;
  - `!` only where a value is guaranteed by construction (e.g. a spawned child's `pid`);
  - prefer `type` imports.
- **Pure core, thin CLIs.** Decision logic lives in `probation/src/*.ts` with no I/O. CLIs in `src/cli/` do I/O and call `main()`. A CLI module must never be imported by another module, because `main()` runs on import. Shared helpers go in `src/`.
- **Errors:**
  - CLIs throw `Error` with an actionable message, and `main()` prints `✖ …` and exits 1;
  - the app returns `{error:{code,message}}`.
- **External calls:** only through `GitLab` (retry built in) or `gcloud` in `ci/*.sh`.
- **Comments** explain why. Match the existing density: one line above non-obvious logic.
- **Imports** use explicit `.ts` extensions.

```ts
// do: pure decision, testable
export function decide(policy: Policy, ledger: Ledger, input: GateInput): GateDecision { … }
// don't: decision mixed with API calls
export async function decide(iid: number) { const mr = await fetch(…); if (mr.labels…) … }
```

## 7. Frontend Rules

- Both pages are server-rendered strings. Escape every interpolated value with `esc()`.
- Colors come from CSS custom properties only, with light and dark variants and the `data-theme` override (DESIGN_SYSTEM §2).
- Animations use transform and opacity only, behind `prefers-reduced-motion: no-preference`.

## 8. Backend Rules

- New Tallybook routes must log census lines automatically (they do, through the `onResponse` hook). Never log raw URLs or bodies.
- New flags go in `FLAG_DEFAULTS` and are read through `request.flag()` so they are counted.
- Policy changes go through `parsePolicy()` validation. Thresholds must stay ascending.

## 9. Prohibited

| Don't | Why | Instead |
|---|---|---|
| Give the flow a merge, pipeline or shell tool | Breaks the core guarantee | The gate merges; the flow proposes |
| Let LLM output decide gate verdicts | Autonomy must be deterministic | Encode rules in `gate.ts` / `policy.yml` |
| Edit `audit.jsonl` history or re-run `settle:*` | Double-scoring, broken audit | Append a compensating event |
| Add `lodash`, `moment` or other utility megapackages | Bloat (and they are the demo's dead dependencies) | Native JS |
| Commit secrets or service-account keys | Leaks | CI masked variables, WIF |
| Use `eslint`/`prettier`/`ts-node`/`tsx` | Duplicate tooling | Biome; Node runs `.ts` natively |
| Name the product with AI | Hackathon FAQ | The human picks the name |

## 10. When Stuck

1. Re-read the relevant ARCHITECTURE section and the test for the behaviour.
2. Reproduce locally with `LEDGER_FILE` and fixtures (TESTING_GUIDE §4).
3. For GitLab or GCP behaviour you can't verify, write the assumption in TASK_LOG Decisions, choose the fallback in PRD §10, and move on.
4. If the same blocker survives 30 minutes, record it in TASK_LOG Blockers and escalate (§12).

## 11. Git & Commits

- Work on the assigned branch; never force-push shared branches.
- Use small commits with `area: summary` subjects (`gate: block coroner objections`).
- The `ledger` branch is written only by CI.

## 12. Human Escalation

Ask Rayhan before you:
- change `policy.yml` thresholds or scoring;
- change forbidden zones;
- spend GitLab Credits on real flow runs beyond the demo plan (RUNBOOK §5);
- touch GCP IAM;
- rename the product.
