# Judge's tour (5 minutes)

The fastest path to verify each judging criterion. Every path below exists in this repository; every job name is spelled as in [`.gitlab-ci.yml`](../.gitlab-ci.yml) or the release child pipeline that [`probation/src/cli/release-plan.ts`](../probation/src/cli/release-plan.ts) generates.

> **What is and isn't live yet.** The live Google Cloud (Cloud Run) deploy and live GitLab Duo flow runs have **not yet been executed**. Until they are, the Probation Board shows an **"Offline rehearsal"** banner and its data comes from the scripted demo ledger (`npm run demo:mock`). Everything below is tested end to end against a GitLab API simulator (`probation/sim/gitlab-fake.ts`), not against gitlab.com.

## Minute 0: run it yourself (optional, about 2 minutes)

```bash
npm run setup && npm run check   # install, lint, typecheck, full Vitest suite
npm run demo:mock                # scripted Undertaker climb and rollback; writes .out/
```

Then open `.out/playground.html` in a browser: it runs the real gate in the page against the demo ledger's scores. `.out/board.html` and `.out/replay.html` are written alongside it.

## Minute 1: watch it

| What | Where |
| --- | --- |
| Rough-cut demo video | [`docs/media/demo-rough-cut.mp4`](media/demo-rough-cut.mp4) (subtitles: `docs/media/demo-rough-cut.srt`) |
| Ledger replay (Undertaker earns trust, breaks the partner export, loses it) | [`docs/media/replay.webm`](media/replay.webm) |
| Board and playground screenshots | [`docs/media/board-light.png`](media/board-light.png), [`docs/media/playground.png`](media/playground.png) |

## Minutes 2 to 4: one stop per criterion

| Criterion | Open this | What to look for |
| --- | --- | --- |
| **Technological Implementation** | [`probation/src/gate.ts`](../probation/src/gate.ts) | A pure function of policy, ledger and MR diff that returns the verdict, labels the MR and sets auto-merge. Guardrails (no merge rights, no auth/CI/policy edits, delete-only, no test edits) are enforced here in code, not in a prompt. |
| | [`probation/src/cli/release-plan.ts`](../probation/src/cli/release-plan.ts) | The release child pipeline is generated per merge: `approve:production` exists only below Hands-off; the soak runs `soak:canary`, `soak:canary-logs` and `soak:canary-signal`; failure takes `rollback:soak` and `rollback:production`. |
| | [`flows/undertaker.yml`](../flows/undertaker.yml) | The Duo Agent Platform flow: exhume, bury, coroner. GitLab API tools only, no coding environment. |
| | [`probation/test/e2e/story.test.ts`](../probation/test/e2e/story.test.ts) | The whole demo story (climb to Hands-off, broken export, rollback, demotion) asserted against the GitLab simulator. |
| **Design** | [`probation/policy.yml`](../probation/policy.yml) | Trust levels, per-zone scoring and protected paths in one readable file, owned by CODEOWNERS. |
| | [`agents/probation-clerk.yml`](../agents/probation-clerk.yml) and [`mcp/`](../mcp/) | Read-only explainers: the Probation Clerk Duo agent and the MCP server (`mcp/tools.ts`) answer "why is this zone still Assisted?" from the same ledger. |
| | `.out/board.html`, `.out/playground.html` | The Probation Board (light, dark, mobile) and the in-browser gate playground. |
| **Potential Impact** | [`docs/SUBMISSION.md`](SUBMISSION.md) | The problem: nobody lets an agent delete code or ship alone. Probation makes autonomy earned per zone and revocable. |
| **Innovation** | [`probation/policy.yml`](../probation/policy.yml) + [`probation/src/gate.ts`](../probation/src/gate.ts) | Autonomy as a score you earn from production evidence and lose on rollback, instead of a setting. An agent that can only delete, and only what production traffic proves is dead. |
| **Presentation** | [`docs/DEMO_SCRIPT.md`](DEMO_SCRIPT.md), [`docs/media/demo-rough-cut.mp4`](media/demo-rough-cut.mp4) | Script and rough cut of the video. |

## Special prizes

| Prize | Open this | What to look for |
| --- | --- | --- |
| **Most Stages Covered** | [`docs/STAGES.md`](STAGES.md) | All nine DevSecOps stages mapped to named jobs: `verify:check`, `verify:replay`, `secure:npm-audit`, `package:image`, `measure:sci`, `probation:gate`, `release:plan`, `release:run`, `deploy:staging`, `deploy:canary`, `promote:production`, `govern:baseline`, `govern:release-notes`, `census:collect`, `census:file`, `undertaker:dig`, `probation:sweep`, `pages`. |
| **Most Environmentally Impactful** | [`docs/SCI.md`](SCI.md) | Software Carbon Intensity (ISO/IEC 21031:2024) measured on every MR and main pipeline by `measure:sci` (`probation/src/cli/sci.ts`), with coefficients in `probation/sci-coefficients.yml`. Deleting dead code is reported as a carbon change, not just a line count. |

## Minute 5: on GitLab

| Where | What to look for |
| --- | --- |
| **CI/CD > Pipelines**, an MR pipeline | Verify, secure and measure jobs, then `probation:gate`. |
| **CI/CD > Pipelines**, a main pipeline | `release:plan` → `release:run` downstream child: `deploy:staging` → (`approve:production`) → `deploy:canary` → soak → `promote:production` or rollback → `settle:survived` / `settle:rolled-back`. |
| **Merge requests**, an Undertaker MR | The gate's note citing the rule file, `probation::<level>` and `zone::<zones>` labels, and any `coroner::objection` label. |
| **Repository**, `ledger` branch | `ledger.json`, the append-only `audit.jsonl`, and `traffic.json`. |
| **Pages** | The Probation Board, `replay.html` and `playground.html`. The "Offline rehearsal" banner stays until live runs land. |
| **Schedules** | The nightly pipeline: `census:collect` → `census:file` → `undertaker:dig` and `probation:sweep` → `pages`. |

## Honest status

| Piece | Status |
| --- | --- |
| Gate, policy, ledger, release-plan generator, board, replay, playground, MCP server | Built and tested (`npm run check`) |
| End-to-end story | Tested against the GitLab API simulator (`probation/test/e2e/story.test.ts`) |
| Live Cloud Run deploy (staging, canary, rollback) | Not yet executed |
| Live Duo flow runs of Undertaker on gitlab.com | Not yet executed |
| Board data | Scripted demo ledger, labelled "Offline rehearsal" |

For operating details see [`docs/RUNBOOK.md`](RUNBOOK.md).
