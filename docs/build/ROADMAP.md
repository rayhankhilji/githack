# Probation + Undertaker — Roadmap

## Overview

The deadline is **2026-10-27 13:00 UTC**. Each phase ends with something deployable and demonstrable.

| Phase | Goal | Features | Est. effort | Owner |
|---|---|---|---|---|
| P0 Foundation | Repo, app, Probation core, flow, CI, infra scripts; first green main pipeline on GitLab with Tallybook live on Cloud Run | F-03, F-04, F-05, F-06, F-07, F-08 | done (code) + 1.5 h (setup) | Claude (code), Rayhan (accounts) |
| P1 Census & first dig | Real traffic → census issues → first Undertaker MR gated at Assisted | F-01, F-02, F-09 | 2 h | Rayhan + agent |
| P2 Climb & fall | Run the 5-act demo for real: Assisted → Supervised → Hands-off → rollback → recover | F-03, F-04, F-05, F-06 | 2.5 h | Rayhan |
| P3 Polish & hardening | Board, SCI numbers, docs, CI tidy, rehearsal | F-06, F-07 | 1.5 h | both |
| P4 Launch | Video, Devpost submission, freeze | all | 2 h | Rayhan |

## Phase 0 — Foundation

**Goal:** the full lifecycle exists in code, and Tallybook is deployed through the pipeline.

**Tasks:**
- [x] P0.T1 — Root tooling (Biome, tsc, Vitest), MIT LICENSE, `.gitignore` · verify: `npm run check`
- [x] P0.T2 — Tallybook app with simulated legacy debt and census logging (F-08) · verify: `npx vitest run app`
- [x] P0.T3 — Probation core: policy, zones, ledger, gate, security, SCI, census, board (F-03, F-04, F-06, F-07, F-01) · verify: `npx vitest run probation`
- [x] P0.T4 — CLIs: gate, census, start-flow, replay, sci, audit, release-plan, soak, settle, baseline, board, flow-print · verify: TESTING_GUIDE §8
- [x] P0.T5 — Undertaker flow definition `flows/undertaker.yml` (F-02) · verify: `npm run flow:print` parses
- [x] P0.T6 — `.gitlab-ci.yml` covering verify, secure, package, measure, gate, release (child), govern and schedule · verify: GitLab pipeline editor "Validate"
- [x] P0.T7 — `infra/gcp-bootstrap.sh`, `ci/deploy.sh`, `ci/gcp-auth.sh`, `app/Dockerfile` · verify: `bash -n` on the scripts
- [ ] P0.T8 — Push to the GitLab hackathon project, make it public, and confirm LICENSE shows in About · refs: RUNBOOK §1 · verify: project page shows "MIT License"
- [ ] P0.T9 — Run `infra/gcp-bootstrap.sh`; add the CI variables (ARCHITECTURE §12); create the project access token · refs: RUNBOOK §2 · verify: variables listed in Settings → CI/CD
- [ ] P0.T10 — First main pipeline green: image built, staging → canary → soak → promote; Tallybook URL live · refs: F-05 · verify: `curl $URL/healthz` returns `{ok:true}`

**Exit criteria:**
- `npm run check` passes on a clean clone.
- A main pipeline on GitLab completed `release:run` successfully.
- The Pages board is published with all zones at Assisted.

**Out of this phase:** the flow running for real, and census issues.

## Phase 1 — Census & first dig (F-01, F-02, F-09)

**Goal:** production traffic produces candidate issues, and Undertaker opens its first gated MR.

**Tasks:**
- [ ] P1.T1 — Create the flow (AI → Flows → New flow, paste `npm run flow:print`), enable it on the project, and note the consumer ID · refs: RUNBOOK §3 · verify: the flow appears under AI → Flows with a service account `ai-undertaker-*`
- [ ] P1.T2 — Spike: start the flow through the Flows API with `start-flow.ts` on a hand-made candidate issue. If the API is refused, switch to the assign-trigger fallback · refs: PRD §9 · verify: T-F09-AC2
- [ ] P1.T3 — Generate traffic: `TALLYBOOK_API_KEY=… node scripts/traffic.ts $URL 1500` · verify: the Logs Explorer shows `jsonPayload.census=1` entries
- [ ] P1.T4 — Create a pipeline schedule (variable `CENSUS_FRESHNESS=6h`) and run it manually · verify: 🪦 issues for fax, the v1 routes, the flags, moment, lodash and formatMoneyLegacy (T-F01-AC2 live)
- [ ] P1.T5 — First real Undertaker run on the fax candidate · verify: T-F02-AC1; the gate note says Assisted (T-F03-AC1 live)

**Exit criteria:** one Undertaker MR exists with a coroner report and a gate note at Assisted; the candidate issue is labelled in-progress.

## Phase 2 — Climb & fall (F-03, F-04, F-05, F-06)

**Goal:** the real pipeline history shows promotion to Hands-off, a rollback demotion, and recovery.

**Tasks:**
- [ ] P2.T1 — Act 1: approve and merge the fax MR → soak survives → ledger +10 → 🎖️ Supervised issue · verify: T-F04-AC1 live
- [ ] P2.T2 — Act 2: dig `POST /api/v1/sync` → gate auto-merges (Supervised) → approve production → +10 · verify: T-F03-AC2, T-F05-AC2 live
- [ ] P2.T3 — Act 3: dig `GET /api/v1/invoices` → +10 → 🎖️ Hands-off · verify: board shows legacy Hands-off
- [ ] P2.T4 — Act 4: dig `GET /api/v1/export.csv` → no human → canary soak synthetic 404 → rollback, revert, −40, ⬇️ demotion, do-not-bury · verify: T-F05-AC4 live
- [ ] P2.T5 — Act 5: dig the `moment`/`lodash` dependency candidate (zone `deps`, Assisted) → approve → SCI note shows the reduction · verify: T-F06-AC2 live

**Exit criteria:** the ledger branch's `audit.jsonl` holds the 5 acts; the board shows the climb-and-fall chart and at least 3 graves plus 1 exhumed.

## Phase 3 — Polish & Hardening

**Goal:** everything a judge clicks works and tells the same story.

**Tasks:**
- [ ] P3.T1 — Re-check `grid.grams_co2e_per_kwh` for the region against Google's published data; update `sci-coefficients.yml` and `docs/SCI.md` · verify: values cited with date
- [ ] P3.T2 — Accessibility and responsive pass on the board (390px, dark mode, reduced motion) · verify: TESTING_GUIDE §10
- [ ] P3.T3 — README: live URLs (Cloud Run, Pages, video), the architecture diagram, and how to run · verify: links resolve
- [ ] P3.T4 — Security checklist (EVAL_GUARDRAILS §2): token scopes, protected variables, CODEOWNERS usernames match GitLab · verify: manual review
- [ ] P3.T5 — Rehearse the video with `docs/DEMO_SCRIPT.md` (timed under 2:55) · verify: stopwatch

**Exit criteria:** the release DoD (EVAL_GUARDRAILS §1) passes except for the video upload.

## Phase 4 — Launch

**Goal:** submitted before 13:00 UTC, with a buffer.

**Tasks:**
- [ ] P4.T1 — Record and upload the video (YouTube, public or unlisted, no copyrighted music) · verify: plays signed-out
- [ ] P4.T2 — Fill the Devpost form from `docs/SUBMISSION.md`: Path A, Hands-off, Environmental opt-in · verify: all required fields saved
- [ ] P4.T3 — Submit by 12:00 UTC. Freeze: no pushes to the judged repo after the deadline (fork to continue) · verify: Devpost shows "Submitted"

**Exit criteria:** the submission is complete, and the Cloud Run and Pages URLs stay live through 2026-11-16.

## Later / Backlog

- F-10 Human-rejection sweep (P1).
- Multi-agent board (several agents on probation side by side).
- Cloud Monitoring alert → issue (incident-driven census).
- Error-rate soak signal from Cloud Logging in addition to synthetics.

## Feature → Phase Map

| Feature | Phase | Tasks |
|---|---|---|
| F-01 | P0, P1 | P0.T3, P1.T3, P1.T4 |
| F-02 | P0, P1 | P0.T5, P1.T1, P1.T5 |
| F-03 | P0, P2 | P0.T3, P2.T2 |
| F-04 | P0, P2 | P0.T3, P2.T1, P2.T3, P2.T4 |
| F-05 | P0, P2 | P0.T6, P0.T10, P2.T4 |
| F-06 | P0, P2, P3 | P0.T3, P2.T5, P3.T1 |
| F-07 | P0, P3 | P0.T3, P3.T2 |
| F-08 | P0 | P0.T2 |
| F-09 | P1 | P1.T2 |
| F-10 | Backlog | — |
