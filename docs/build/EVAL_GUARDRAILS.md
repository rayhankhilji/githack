# Probation + Undertaker — Evaluation & Guardrails

> Version: 1.0 · Updated: 2026-10-26

## 1. Definition of Done

### Task-level DoD (every task)
- [ ] The acceptance criteria the task references pass, with test IDs listed in TASK_LOG.
- [ ] `npm run check` is clean (Biome, tsc, Vitest), with no new warnings.
- [ ] Contracts match ARCHITECTURE §5 and §12, and docs are updated if a contract changed.
- [ ] No secrets and no debugging output; touched code has no leftover placeholder notes.
- [ ] TASK_LOG is updated.

### Phase-level DoD
- [ ] The ROADMAP exit criteria pass.
- [ ] The phase's pipeline ran green at least once on GitLab, and the run is visible in the pipeline history.

### Release DoD (submission)
- [ ] The repo is public on GitLab, with MIT LICENSE showing in About.
- [ ] Pipeline history shows the census, a gated MR, a release with soak, a promotion and a rollback.
- [ ] Cloud Run URL and Pages board are live; the video is under 3:00 and public or unlisted on YouTube.
- [ ] The Devpost text is filled from `docs/SUBMISSION.md`, with the Environmental opt-in text included.

## 2. Security Guardrails

| ID | Rule | Reason | Verified by |
|---|---|---|---|
| G-SEC-01 | Agent MRs merge only through `probation:gate` | Autonomy is enforced, not trusted | T-F03-AC1..AC3; the flow has no merge tool |
| G-SEC-02 | `app/src/auth/**`, `probation/**`, `flows/**`, `agents/**`, `mcp/**`, `ci/**`, `infra/**`, `.gitlab/**` and `.gitlab-ci.yml` are forbidden to the agent | The agent can't widen its own leash or weaken auth | T-F03-AC5, T-F03-AC6; CODEOWNERS |
| G-SEC-03 | Agent MRs must remove more lines than they add, and may only delete tests | Deletion-only mandate; the safety net can't be weakened | T-F03-AC7, T-F03-AC9 |
| G-SEC-04 | New security findings block and cost −30 | Deletions must not add risk | T-F03-AC8, T-F02-AC3 |
| G-SEC-05 | GCP auth through WIF restricted to this project's path; no keys in the repo | No long-lived credentials | `infra/gcp-bootstrap.sh` attribute condition |
| G-SEC-06 | Tokens are masked and protected CI variables; `GITLAB_PROBATION_TOKEN` is a project token, `DUO_FLOW_TRIGGER_TOKEN` is used only by `undertaker:dig` | Least privilege | RUNBOOK §2 |
| G-SEC-07 | Census lines carry route templates, never raw paths, queries or bodies | No PII in logs | T-F01-AC1; `server.ts` hook |
| G-SEC-08 | All interpolated HTML is escaped | XSS in the board or dashboard | T-F07-AC1 |

## 3. AI / Agent Guardrails

| ID | Rule | Verified by |
|---|---|---|
| G-AI-01 | Every system prompt declares issue, MR and repo content as data, not instructions | Review of `flows/undertaker.yml` |
| G-AI-02 | Tool sets are least-privilege per component: exhume read-only, coroner note and label only | Flow YAML review |
| G-AI-03 | `coding_environment: none`: no shell or clone in the flow | Flow YAML |
| G-AI-04 | A coroner objection blocks the gate | Gate code (`coronerObjection`) |
| G-AI-05 | Weak evidence (fewer than 200 requests) yields no route or flag candidates, and the flow must answer `bury:false` on weak evidence | T-F01-AC3; exhume prompt |
| G-AI-06 | A rollback marks the candidate do-not-bury, so the agent never retries a grave that bit back | T-F01-AC4; `settle.ts` |

## 4. Cost & Token Budgets

| ID | Budget | Enforcement |
|---|---|---|
| G-COST-01 | ≤ 15 GitLab Credits per Undertaker run | One candidate per run; prompt timeouts 180 / 300 / 240 s; check the GitLab Credits dashboard after each run |
| G-COST-02 | ≤ 10 real flow runs before submission (of 500 monthly credits) | RUNBOOK §5 demo plan; `demo:mock` for rehearsals |
| G-COST-03 | MR pipeline ≤ 6 minutes; release ≤ 10 minutes | Soak minutes in `policy.yml`; `SCI_DURATION` 10 s |
| G-COST-04 | Cloud Run min instances 0, max 3, 256Mi | `ci/deploy.sh` flags |

## 5. Error Handling Conventions

- **CLIs:** throw `Error("<what failed>: <detail>")`. `main()` prints `✖ <message>` and exits 1, which fails the job with the reason on the last line.
- **GitLab API:** the error reads `GitLab <METHOD> <path> → <status>: <body≤500>`. 429 and 5xx are retried 3 times; everything else fails fast.
- **Gate:** a blocked verdict posts the MR note *first*, then exits 1, so the reason is always visible on the MR.
- **App:** `{error:{code,message}}`, with codes `unauthorized`, `not_found` and `fax_gateway_unavailable`, plus Fastify's validation 400.
- **Release:** any failure in staging, canary or soak runs `rollback:production` (when: on_failure). Settle on a rollback reverts the commit.

## 6. Reliability & Performance Budgets

| ID | Budget |
|---|---|
| G-PERF-01 | Tallybook p95 < 50 ms under the CI autocannon mix (10 connections) |
| G-PERF-02 | Cold start (process spawn to healthy) < 1,000 ms locally |
| G-PERF-03 | Rollback restores the previous revision to 100% within 60 s of a soak failure |
| G-PERF-04 | Board renders under 100 KB of HTML for 500 events |

## 7. Quality Evals

- **Code:**
  - the pure modules (`gate`, `ledger`, `census`, `sci`, `security`, `board`) have unit tests for every acceptance criterion in PRD §5;
  - CLIs are smoke-tested locally per TESTING_GUIDE §8.
- **Agent eval (manual, blocking for the demo):** run Undertaker on 3 candidates (`dependency:moment`, `route:POST /api/fax-invoice`, `flag:legacyPdf`). Each run passes if:
  1. exactly one MR is opened;
  2. it removes more than it adds;
  3. no forbidden path is touched;
  4. the coroner note is present;
  5. `verify:check` stays green.
  - **Pass threshold:** 3 of 3 before recording.
- **UX rubric (1–5):** board clarity, evidence on MR notes, consistency of level colors and words. The minimum to ship is 4 on each.

## 8. Privacy & Compliance

No personal data is processed. Tallybook seed data is fictional. Census logs hold method, route template, status and flags only. The ledger is public on the Pages board by design.

## 9. Change Control

- `policy.yml`, `synthetics.yml`, `flows/`, `ci/`, `.gitlab-ci.yml` and `.gitlab/` are CODEOWNERS-protected, so changes need the owner's approval.
- Scoring or threshold changes are recorded in TASK_LOG Decisions, with the reason.
