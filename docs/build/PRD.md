# Probation + Undertaker — Product Requirements

> Profile: AI / agent product (+ developer tool) · Scope tier: Prototype (hackathon) · Version: 1.0 · Updated: 2026-10-26

## 1. Summary

**Undertaker** is a GitLab Duo Agent Platform flow with one job: delete code that production telemetry proves is dead (unused routes, stale feature flags, unused dependencies, orphan exports).

**Probation** is the deterministic CI system that decides how much autonomy Undertaker has. Autonomy is earned per code zone through deploys that survive production, and lost instantly on a rollback. A brand-new agent starts at **Assisted**, where a human approves everything. It promotes itself to **Supervised** and then **Hands-off** as it proves itself, and it is demoted the moment it breaks a real client.

The point of the project: "code generation is solved, so what happens after?" Code piles up, and nobody trusts an agent to remove it. Probation is how you hand over control *gradually and reversibly*. It is built for the GitLab Transcend "Life After Code" hackathon (Path A, Hands-off category, plus the Environmental prize opt-in).

## 2. Problem & Opportunity

- **Code only grows.** Teams ship features behind flags, version APIs and add dependencies, but rarely remove anything. Dead code costs build minutes, image size, cold-start time, attack surface and reviewer attention. Every one of those costs is compute, and compute is carbon.
- **Deleting code is the scariest kind of change,** because a "dead" route might have one monthly caller. So nobody does it.
- **Agent autonomy is configured, not earned.** Today you pick a level (assisted, supervised, hands-off) up front and hope for the best. Enterprises need a way to start an agent on a short leash and extend it based on evidence.
- **Opportunity:** combine production telemetry (what is actually dead), a deletion-only agent (small, reviewable, reversible changes), and a trust ledger enforced by CI. The agent climbs to Hands-off on a track record, not on a setting.

## 3. Target Users

| Persona | Context | Goals | Frustrations | Technical level | Primary device |
|---|---|---|---|---|---|
| **Platform lead "Priya"** (primary) | Owns CI/CD and developer experience for 20–200 engineers on GitLab | Shrink the codebase and cloud bill; adopt agents safely | Can't justify letting an AI merge to prod; dead code nobody owns | High | Desktop browser (GitLab UI) |
| Engineering manager | Accountable for incidents and audit | An audit trail of what the agent did and why it was allowed to | "Who approved this?" after an incident | Medium | Desktop browser |
| Hackathon judge | Evaluating on Devpost and YouTube within minutes | See the automation run end-to-end with a clear story | Vague demos, generic "issue → MR" flows | High | Desktop browser |

## 4. Core User Journeys

1. **First run, time to value under 15 minutes.** Priya pushes the repo to GitLab, runs `infra/gcp-bootstrap.sh`, and sets the CI variables. The first main pipeline deploys Tallybook to Cloud Run, and the Probation Board shows every zone at Assisted. *(F-08, F-05, F-07)*
2. **Census.** A nightly schedule reads Cloud Run request logs and files 🪦 candidate issues with evidence. *(F-01)*
3. **Assisted burial.** The schedule starts Undertaker on the top candidate. Undertaker opens a deletion MR, and its coroner step reviews it. The gate says "Assisted: a human must approve". Priya merges, the canary survives the soak, and the ledger adds +10, which promotes Undertaker to Supervised in that zone. *(F-09, F-02, F-03, F-05, F-04)*
4. **Supervised, then Hands-off.** Next burials in the zone auto-merge. At Supervised, production waits for one click. After enough survivals Undertaker is Hands-off, and burials go from issue to production with no human. *(F-03, F-05, F-04)*
5. **Demotion.** Undertaker buries `GET /api/v1/export.csv`, which had 0 hits in 7 days. During the soak, the bookkeeping partner's monthly synthetic returns 404, so the pipeline rolls back traffic, reverts the commit, scores −40 (Hands-off → Assisted), and marks the candidate do-not-bury. *(F-05, F-04, F-01)*
6. **Audit.** The manager opens the Probation Board and the `ledger` branch's `audit.jsonl` to see every score change with its MR and pipeline. *(F-07, F-04)*

## 5. Features

### F-01 · Census: find dead code from production telemetry — Priority: P0
- **User story:** As a platform lead, I want dead code identified from real production traffic so that deletions are based on evidence, not guesses.
- **Details:**
  - Every request logs one structured line `{census:1, method, route, status, flags}`.
  - The scheduled `census:collect` job reads 7 days of Cloud Run logs, and `census:file` finds candidates:
    - routes with 0 hits, when at least 200 requests were seen;
    - flags that were always on, always off, or never evaluated;
    - dependencies in `app/package.json` that are never imported;
    - exports with no reference outside their own definition.
  - It files one issue per candidate (labels `undertaker::candidate`, `zone::<z>`, `kind::<k>`), deduplicated by a hidden key marker.
  - It skips candidates labelled `undertaker::do-not-bury` and routes in `policy.census.keep`.
  - It publishes `traffic.json` to the `ledger` branch.
- **States:** no logs (0 candidates, and no route or flag verdicts below 200 requests) · candidates found · already filed (skipped) · do-not-bury (skipped).
- **Acceptance criteria:**
  - F-01.AC1 — Given gcloud JSON entries or JSONL census lines, When parsed, Then only census lines are counted.
  - F-01.AC2 — Given 400+ requests that never hit `POST /api/fax-invoice`, When the census runs, Then a route candidate is created that points at `app/src/legacy/fax.ts`; and `GET /healthz` and live routes are not candidates.
  - F-01.AC3 — Given fewer than `min_requests_in_window` requests, When the census runs, Then no route or flag candidates are produced.
  - F-01.AC4 — Given a candidate key marked do-not-bury, When the census runs, Then it is not proposed again.
- **Dependencies:** F-08 (census log lines), Cloud Logging.

### F-02 · Undertaker flow (exhume → bury → coroner) — Priority: P0
- **User story:** As a platform lead, I want an agent that turns a candidate issue into a minimal deletion MR so that cleanup happens without engineering time.
- **Details:**
  - A custom Duo flow (`flows/undertaker.yml`, registry v1, `coding_environment: none`) with three AgentComponents:
    - `exhume` (read-only investigation; outputs a JSON burial plan, or `bury:false` with a reason);
    - `bury` (branch, a single deletion commit, an MR labelled `undertaker` with the epitaph and evidence);
    - `coroner` (adversarial self-review; posts a "Coroner's report" and adds `coroner::objection` if it finds a live reference).
  - The flow never merges, and has no tool to do so.
- **States:** plan rejected (note on issue) · MR opened · coroner objection · coroner clear.
- **Acceptance criteria:**
  - F-02.AC1 — Given a candidate issue, When the flow runs, Then exactly one MR labelled `undertaker` exists, with "Closes #n" and the census evidence in its description.
  - F-02.AC2 — Given weak evidence or a live reference, When `exhume` runs, Then no MR is created and the issue gets a note with the reason.
  - F-02.AC3 — Given an MR introducing a security finding, When the gate runs, Then it is blocked and scored `security_finding` (tests via F-03).
  - F-02.AC4 — Given an MR labelled `undertaker` or authored by `ai-undertaker*`, When the gate runs, Then it is treated as Undertaker's.
- **Dependencies:** GitLab Duo Agent Platform, AI Catalog, F-01.

### F-03 · Probation gate — Priority: P0
- **User story:** As a platform lead, I want a deterministic gate to decide how far each agent MR goes on its own so that autonomy is enforced by the pipeline, not by the model's judgement.
- **Details:**
  - `probation:gate` runs last in MR pipelines. It classifies changed files into zones (`probation/policy.yml`) and looks up the agent's score per zone.
  - It takes the **minimum** level across touched zones and posts a decision note:
    - **Assisted:** needs a human;
    - **Supervised:** auto-merge, but production needs approval;
    - **Hands-off:** auto-merge and auto-release.
  - It blocks when the MR:
    - touches a forbidden zone (`auth`, `probation`, which includes its own rules and CI);
    - touches a file outside every zone;
    - adds more lines than it removes;
    - edits or adds test lines (deleting tests of buried code is neutral);
    - introduces new security findings;
    - carries `coroner::objection`.
- **States:** not applicable (human MR) · blocked · needs human · merge supervised · merge hands-off.
- **Acceptance criteria:**
  - F-03.AC1 — Given score 0, When Undertaker deletes legacy code, Then the verdict is needs_human (Assisted).
  - F-03.AC2 — Given legacy score ≥ 10, Then the verdict is merge_supervised.
  - F-03.AC3 — Given score ≥ 30 in every touched zone, Then the verdict is merge_hands_off and auto-merge is set.
  - F-03.AC4 — Given zones at different levels, Then the least-trusted zone decides.
  - F-03.AC5 — Given any file in `app/src/auth/**`, Then the MR is blocked whatever the score.
  - F-03.AC6 — Given an edit to `probation/policy.yml`, Then the MR is blocked (the agent can't change its own leash).
  - F-03.AC7 — Given a net-additive diff, Then the MR is blocked.
  - F-03.AC8 — Given a new security finding, Then the MR is blocked and the zone is scored −30.
  - F-03.AC9 — Given deleted tests only, Then they are neutral; given an added test line, Then the MR is blocked.
- **Dependencies:** F-04, GitLab MR API, project access token.

### F-04 · Trust ledger: scoring, promotion, demotion — Priority: P0
- **User story:** As an engineering manager, I want every change in an agent's autonomy recorded with its cause so that I can audit why it was allowed to act.
- **Details:**
  - Scores per agent and zone, with scoring and thresholds in `policy.yml`:
    - events: survived_soak +10, rolled_back −40, human_rejected −20, security_finding −30, with a floor of 0;
    - levels: Supervised ≥ 10, Hands-off ≥ 30 (demo-accelerated).
  - Storage: `ledger.json` plus append-only `audit.jsonl` on the `ledger` branch, with commits marked `[skip ci]`.
  - A level change opens a 🎖️ Promotion or ⬇️ Demotion issue.
- **States:** empty ledger · scored · promoted · demoted.
- **Acceptance criteria:**
  - F-04.AC1 — Given score 0, When a soak survives, Then the score is 10 and the level moves Assisted → Supervised.
  - F-04.AC2 — Given Hands-off (30), When rolled back, Then the score is 0 and the level is Assisted.
  - F-04.AC3 — Given score 0, When human_rejected, Then the score stays 0.
  - F-04.AC4 — Given a change touching two zones, Then one event per zone is appended, and the previous ledger object is not mutated.
- **Dependencies:** GitLab Repository Files and Commits APIs.

### F-05 · Canary release, soak and rollback — Priority: P0
- **User story:** As a platform lead, I want every agent change proven against production before full rollout so that a wrong deletion costs minutes, not an outage.
- **Details:**
  - After a merge, `release:plan` reads the merged MR's `probation::<level>` label and generates the child pipeline:
    1. deploy the revision with 0% traffic and a tag (staging);
    2. `approve:production` (manual unless Hands-off or human-authored);
    3. canary at 10%;
    4. a soak of 3 minutes of synthetics (`probation/synthetics.yml`) against the tagged revision;
    5. promote to 100%, or roll back to the previous revision and revert the commit;
    6. settle the score.
- **States:** staging · awaiting approval · canary · soaking · promoted · rolled back.
- **Acceptance criteria:**
  - F-05.AC1 — Given a Hands-off MR, Then `approve:production` is automatic and `settle:survived` exists.
  - F-05.AC2 — Given a Supervised MR, Then `approve:production` is manual.
  - F-05.AC3 — Given a human commit, Then it deploys but is never scored.
  - F-05.AC4 — Given a synthetic returning 404 on the canary, Then the soak fails, which triggers rollback and `settle:rolled-back`.
- **Dependencies:** Cloud Run, F-04.

### F-06 · Software Carbon Intensity per change — Priority: P0
- **User story:** As a platform lead, I want each deletion's carbon effect measured with a public method so that the sustainability gain is quantified, not claimed.
- **Details:**
  - `measure:sci` boots the app, runs a fixed 10-second autocannon mix, and reads CPU-seconds and RSS from `/proc`, cold-start time, and deployable size.
  - It computes SCI = (E·I + M) per 1,000 requests with Cloud Carbon Footprint coefficients (`probation/sci-coefficients.yml`).
  - It posts the before/after table on the MR. The baseline is updated after each surviving release.
- **States:** no baseline (first run) · delta shown.
- **Acceptance criteria:**
  - F-06.AC1 — Given a measurement, Then SCI equals the sum of its components and is positive.
  - F-06.AC2 — Given a smaller deployable and faster cold start, Then SCI decreases and the MR table shows a negative Δ.
- **Dependencies:** F-08.

### F-07 · Probation Board — Priority: P0
- **User story:** As a judge or manager, I want one public page showing autonomy by zone, trust over time, the graveyard and the SCI trend so that the story is visible at a glance.
- **Details:** a static GitLab Pages site rendered from the ledger by the `pages` job on main and schedule pipelines. It works in light and dark themes and at 390px width.
- **States:** empty ledger (explanatory empty states) · populated.
- **Acceptance criteria:**
  - F-07.AC1 — Given a ledger with events and graves, Then the board renders zone cards (forbidden zones marked), the step chart, tombstones (titles escaped) and the ledger table.
- **Dependencies:** F-04.

### F-08 · Tallybook demo app — Priority: P0
- **User story:** As a judge, I want a realistic app with realistic legacy debt so that the deletions mean something.
- **Details:**
  - An invoice tracker: Fastify 5 on Node 22 with type stripping.
  - It has a dashboard plus JSON API (`GET/POST /api/invoices`, `GET /api/invoices/:id`, `POST /api/invoices/:id/pay`, `GET /api/invoices/:id/pdf`).
  - Simulated legacy debt, disclosed in the README:
    - `/api/v1/*` routes and `/api/fax-invoice`;
    - flags `newTotals`, `legacyPdf` and `holidayBanner2024`;
    - unused `moment` and `lodash`;
    - the orphan `formatMoneyLegacy`.
- **States:** dashboard empty (no invoices) · populated · API errors use `{error:{code,message}}`.
- **Acceptance criteria:** covered by `app/test/server.test.ts`: listing, auth on writes, create and pay, validation, 404, dashboard render, the monthly export, census lines, and the route inventory.
- **Dependencies:** none.

### F-09 · Autonomous dig schedule — Priority: P0
- **User story:** As a platform lead, I want Undertaker started automatically on the next candidate so that the loop runs without anyone clicking.
- **Details:**
  - `undertaker:dig` (schedule) picks the first open candidate in a non-forbidden zone, ordered dependency → export → flag → route.
  - It starts the flow with the Flows API (`POST /api/v4/ai/duo_workflows/workflows`, `ai_catalog_item_consumer_id`) using the owner's token.
  - It labels the issue `undertaker::in-progress`.
- **States:** nothing to dig · started · API refused (job fails with the API error).
- **Acceptance criteria:**
  - F-09.AC1 — Given two open candidates (dependency, route), When dig runs with `--dry-run`, Then the goal names the dependency issue and its zone level.
  - F-09.AC2 — Given a successful start, Then the issue is labelled in-progress and gets a note with the flow ID.
- **Dependencies:** F-01, F-02, the Flows API.

### F-10 · Human-rejection sweep — Priority: P1
- **User story:** As a platform lead, I want closed-without-merge agent MRs to cost trust so that sloppy proposals have consequences.
- **Details:** during the schedule, score `human_rejected` for each Undertaker MR closed without merge that isn't yet in the ledger.
- **Acceptance criteria:**
  - F-10.AC1 — Given a closed, unmerged Undertaker MR, When the sweep runs, Then its zones get −20 once.

## 6. Out of Scope

- **Undertaker writing new code, refactors or tests.** The mandate is deletion only, enforced by the gate.
- **Multi-agent ledgers in the UI.** The ledger supports many agents; the board shows the first one.
- **Inbound webhooks from Cloud Monitoring.** The census is pull-based on a schedule; the flow sandbox can reach only GitLab.
- **Persistent database for Tallybook.** In-memory seed data is enough to demonstrate deletions.
- **Real 30-day soak windows.** They are demo-accelerated and documented as such.

## 7. Success Metrics

| Metric | Definition | Target | Tool |
|---|---|---|---|
| **North star:** lines buried in production | Sum of `linesRemoved` for graves with status `buried` | ≥ 30 lines by submission | Probation Board |
| Activation | First Undertaker MR merged and survived | 1 within the first demo run | Ledger `survived_soak` event |
| Autonomy reached | Highest level reached in any zone | Hands-off in `legacy` | Ledger |
| Safety | Rollbacks that left production broken after the soak | 0 | Soak and rollback job logs |
| Sustainability | SCI change from first to last baseline | Negative (reduction), reported with method | `ledger.sci.history`, board |
| Cost | GitLab Credits per Undertaker run | ≤ 15 | GitLab Credits dashboard |

## 8. Non-Functional Requirements

- **Pipeline time:**
  - MR pipeline (verify + secure + measure + gate) p50 < 6 min.
  - Release child pipeline < 10 min including a 3-minute soak.
- **App:** p95 < 50 ms on the autocannon mix in CI; cold start < 1 s.
- **Availability:** a failed soak restores the previous revision to 100% traffic in < 1 min.
- **Accessibility:** the board meets WCAG 2.2 AA contrast, is readable at 390px, and respects `prefers-reduced-motion`.
- **Privacy:** census lines contain route templates, never raw URLs, query strings or bodies.
- **Data retention:** the ledger is kept forever (git history); Cloud Logging uses its default 30-day retention.

## 9. Assumptions

- **Path A (Start Fresh).** The connected repo was empty, so Path B was impossible. Change by importing an MIT project and re-pointing `app/`.
- **Demo-accelerated thresholds** (Supervised 10, Hands-off 30, 3-minute soak) so the full arc fits a 3-minute video. They live in `policy.yml`.
- **The Flows API is used to start the custom flow from CI** with the owner's personal access token. If the platform refuses API-started custom flows, the fallback is assigning the candidate issue to the flow's service account (one click; an assign trigger).
- **GitLab.com SaaS** with Ultimate features available in the hackathon group (security templates, CODEOWNERS, Pages).
- **Region us-central1.** Grid intensity is in `sci-coefficients.yml` and must be re-checked against Google's published region data before submission.

## 10. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Flow YAML schema differs from the docs (v1 vs flow_v2) | Paste it through the UI editor first, which validates; fix keys there and copy back |
| API-started flows refused (composite identity flag) | Fallback: assign trigger on the candidate issue |
| GitLab Credits run out mid-demo | `npm run demo:mock` reproduces the full arc offline; real runs are capped by `max_cycles` |
| Census misses periodic clients | Soak synthetics are independent of the census; the rollback is the designed safety net (and the demo's climax) |

## 11. Open Questions

| Question | Owner | Default if unanswered | Decide by |
|---|---|---|---|
| Final product name (the FAQ asks for a human-chosen name) | Rayhan | "Probation" | P4 |
| Keep the 3-minute soak or lengthen it for the video? | Rayhan | 3 minutes | P3 |
| Enter Environmental or Most Stages as the special prize? | Rayhan | Opt in to Environmental; Most Stages is judged automatically | P4 |

## 12. Glossary

- **Zone:** a set of path globs in `policy.yml`. Trust is earned per zone.
- **Census:** the scheduled analysis of production request logs.
- **Grave / burial:** a deletion MR that survived production.
- **Exhumed:** a deletion that was rolled back.
- **Soak:** the timed synthetic checks against the canary revision.
- **SCI:** Software Carbon Intensity, gCO₂e per functional unit (here, 1,000 requests).
