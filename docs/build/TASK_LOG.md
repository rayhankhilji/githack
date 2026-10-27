# Task Log — Probation + Undertaker

## Status

- **Current phase:** P0 — Foundation
- **Current focus:** P0.T8 — Push to the GitLab hackathon project and make it public
- **Next action:** Rayhan runs `GITLAB_REPO_URL=… scripts/push-to-gitlab.sh` (docs/RUNBOOK.md §1)
- **Blocked:** P0.T8–P0.T10 need Rayhan's GitLab and GCP accounts
- **Last updated:** 2026-10-27 by Claude

## Current Phase Checklist

- [x] P0.T1 — Root tooling, MIT LICENSE (tests: `npm run check`)
- [x] P0.T2 — Tallybook app (tests: `app/test/server.test.ts`)
- [x] P0.T3 — Probation core (tests: T-F01-*, T-F03-*, T-F04-*, T-F06-*, T-F07-AC1)
- [x] P0.T4 — CLIs (smoke: replay ok; census candidates filed; SCI measured; release plan generated; mock story)
- [x] P0.T5 — Flow definition (`npm run flow:print` parses)
- [x] P0.T6 — `.gitlab-ci.yml` (parses locally; needs GitLab validation)
- [x] P0.T7 — Infra scripts and Dockerfile (production install runs `node src/index.ts`)
- [ ] P0.T8 — Push to GitLab, public, LICENSE in About
- [ ] P0.T9 — GCP bootstrap and CI variables
- [ ] P0.T10 — First green main pipeline, Tallybook live

## Up Next

- P1.T1 — Create and enable the flow in AI Catalog.
- P1.T2 — Spike the Flows API start (fallback: assign trigger).
- P1.T3 — Generate traffic.

## Blockers

| Since | Blocker | Owner | Unblocks |
|---|---|---|---|
| 2026-10-26 | Needs the GitLab project URL and a project access token | Rayhan | P0.T8, P0.T9 |
| 2026-10-26 | Needs a GCP project with billing for `infra/gcp-bootstrap.sh` | Rayhan | P0.T9, P0.T10 |

## Decisions & Deviations

| Date | Decision | Reason |
|---|---|---|
| 2026-10-26 | Path A (Start Fresh) instead of Path B | The connected repo was empty; Path B needs an existing MIT project |
| 2026-10-26 | Thresholds Supervised 10, Hands-off 30, soak 3 min | The 5-act arc fits a 3-minute video; marked demo-accelerated in `policy.yml` |
| 2026-10-26 | Verify-stage replay uses census traffic only; synthetics run in the soak | Synthetics model clients the census can't see; catching them in production (canary) is the designed safety net |
| 2026-10-26 | Gate diffs `npm audit` findings, not template job artifacts | Template job names vary across GitLab versions; the gate must not depend on them |
| 2026-10-26 | Flow uses `coding_environment: none` and API tools only | No clone, so faster, cheaper, and no shell for the agent |
| 2026-10-26 | Tests zone is neutral: deletions allowed, additions or edits blocked | Burying code includes its tests; the agent must never weaken the safety net |

## Session Log

### 2026-10-26 — Session 1
- **Done:** P0.T1–P0.T7.
  - Build docs generated in `docs/build/`.
  - RUNBOOK, DEMO_SCRIPT, SUBMISSION and SCI written.
- **Tests:** `npm run check` gives 40 passed.
  - `npm run demo:mock` shows Assisted → Supervised → Hands-off → demoted → Supervised.
  - The board was screenshotted in light (1100px) and dark (390px).
- **Notes:**
  - No Docker daemon in the build sandbox, so the container was validated by a production-only install running `node src/index.ts`.
  - CI YAML is not yet validated against GitLab's linter.
- **Next:** P0.T8 (Rayhan).

### 2026-10-26 — Session 2 (parallel verification)
- **Done:**
  - CI validated against GitLab's `ci.json` schema; fixed MR security jobs, release tags, ledger exclusion, concurrent releases, and a bogus rollback on a staging failure.
  - Flow validated against `flow_v2.json` (dropped `max_cycles`); Flows API and the GraphQL consumer-id query confirmed from source.
  - GCP deploy, auth and bootstrap hardened; grid intensity verified at 432 gCO₂e/kWh for us-central1 (2025).
  - F-10 sweep implemented and scheduled.
  - Independent review fixed:
    - `audit.jsonl` create/update crash;
    - silent empty-ledger overwrite;
    - HEAD traffic failing replay;
    - diff lines starting with `++`/`--`;
    - renames bypassing forbidden zones;
    - wrong issue matched in settle;
    - do-not-bury key regex;
    - repeat security scoring;
    - concurrent ledger writers (`resource_group: ledger`).
- **Tests:** 56 passed; docs validator 0 errors.
- **Next:** P0.T8 (Rayhan).

### 2026-10-27 — Session 3 (build swarm, wave 3)
- **Done:**
  - WS1: in-memory GitLab fake (`probation/sim`) and an e2e of the real CLIs across the 5-act story. It found 4 bugs: census `traffic.json` on first run, scoped lifecycle labels, merge sha in merged-results pipelines, Retry-After.
  - WS2: Probation Clerk Duo Chat agent, AI Catalog sync on `catalog-*` tags, stdio MCP server, RUNBOOK §8 triggers.
  - WS3: board sparkline, next-promotion, nine-stage strip and meta; 5 video title cards; board screenshots.
  - WS4: architecture and stages diagrams, `docs/STAGES.md`, README and SUBMISSION copy.
  - WS5 review fixed:
    - the catalog token exposed to MR pipelines;
    - candidate issues stuck after a human rejection (now do-not-bury);
    - the MCP server answering from a missing ledger;
    - issue pagination;
    - Retry-After cap;
    - zero-baseline sparkline.
- **Tests:** 81 passed; docs validator 0 errors.
- **Next:** P0.T8 (Rayhan): push to GitLab, then RUNBOOK §2–5.

### 2026-10-27 — Session 4 (build swarm, wave 4)
- **Done:**
  - WS6: `npm run gitlab:setup` (labels, schedule, protected tag, MR settings) and `npm run doctor` (read-only preflight), with 7 e2e tests against the fake.
  - WS7: canary error-rate signal (`soak:canary-logs` → `soak:canary-signal`: 5xx rate and deleted-route 404s versus the previous revision) and stale in-progress reset in the sweep.
  - WS8: ledger replay page (`replay.html` next to the board) and the recorded clip `docs/media/replay.webm`/`.mp4` with key frames.
  - Forbidden zone now includes `agents/**` and `mcp/**` (Rayhan approved).
- **Tests:** 114 passed after the WS9 review fixes (soak noise floor, atomic log reads, fast rollback, final decline); docs validator 0 errors.
- **Next:** Rayhan runs `npm run gitlab:setup` → `npm run doctor` → RUNBOOK §2–5.

### 2026-10-27 — Session 5 (build swarm, wave 5)
- **Done:**
  - WS12: docs truth check. `probation/src/doccheck.ts` + `node scripts/check-docs.ts` verify every relative link, backticked repo path, CI job name (`.gitlab-ci.yml`, the release child pipeline, the catalog-sync component), `npm run` script and the thresholds, scores and SCI coefficients quoted in the Markdown; `probation/test/docs.test.ts` runs it in `npm test`.
  - Docs brought up to date: the canary signal jobs and `rollback:soak`, `gitlab:setup`/`doctor`/`demo`, the ledger replay, the MCP server and Clerk; hard-coded test counts removed; the dependency size claim re-measured.
  - Container verified for the first time with a real Docker daemon: `app/Dockerfile` builds, runs as `node` (uid 1000) on a read-only root filesystem, honours `PORT` and `K_REVISION`, stops at once on SIGTERM; `/healthz` and `/` return 200. Image 360 MB uncompressed (83.5 MB compressed); without `moment` and `lodash` it is 348 MB, and production `node_modules` shrinks from 16.0 to 10.2 MB.
- **Tests:** `npm run check` green; docs check 0 errors; docs validator 0 errors.
- **Next:** Rayhan runs `npm run gitlab:setup` → `npm run doctor` → RUNBOOK §2–5.

### 2026-10-27 — Session 5 review fixes (WS13)
- `demo approve` decides before approving (no stray approvals), checks that the head pipeline is for the MR's latest commit, and prints `watch --after <ID>`, so watch can't miss the post-merge pipeline.
- `watch --interval` floor is 1 s; the replay tick mark has a fallback colour where `color-mix` isn't supported.
- RUNBOOK: `promote` is needed for every level except Hands-off; act 4 starts `watch --new` before the merge.
- **Tests:** 142 passed; check-docs 0 errors.

## Completed Phases

None yet.
