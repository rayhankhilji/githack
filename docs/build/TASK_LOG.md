# Task Log — Probation + Undertaker

## Status

- **Current phase:** P0 — Foundation
- **Current focus:** P0.T8 — Push to the GitLab hackathon project and make it public
- **Next action:** Rayhan runs `GITLAB_REPO_URL=… scripts/push-to-gitlab.sh` (docs/RUNBOOK.md §1)
- **Blocked:** P0.T8–P0.T10 need Rayhan's GitLab and GCP accounts
- **Last updated:** 2026-10-26 by Claude

## Current Phase Checklist

- [x] P0.T1 — Root tooling, MIT LICENSE (tests: `npm run check`)
- [x] P0.T2 — Tallybook app (tests: app/test/server.test.ts, 9 tests)
- [x] P0.T3 — Probation core (tests: T-F01-*, T-F03-*, T-F04-*, T-F06-*, T-F07-AC1)
- [x] P0.T4 — CLIs (smoke: replay ok; census 13 candidates; SCI measured; release plan generated; mock story)
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

## Completed Phases

None yet.
