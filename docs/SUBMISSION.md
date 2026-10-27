# Devpost submission draft

> Replace every line marked ✏️ before you submit. Pick the final name yourself (the FAQ asks for a human-chosen name, not an AI-chosen one). "Probation" is a working title. Numbers in this file are only ones the code or a cited source gives; every measured result is a ✏️ until you copy it from a real pipeline.
>
> Each `##` section below maps to one Devpost field and is Markdown, ready to paste as is.

**Name:** Probation ✏️
**Tagline:** An AI that deletes dead code, and has to earn the right to ship it.
**Path:** A: Start Fresh · **Category:** Hands-off · **Special prizes:** Most Stages Covered, Most Environmentally Impactful
**Links:**
- ✏️ GitLab repo
- ✏️ Tallybook on Cloud Run
- ✏️ Probation Board (GitLab Pages)
- ✏️ YouTube video (under 3 minutes)
- ✏️ Ledger replay (`replay.html` on the Pages site; a 30-second recording is in `docs/media/replay.webm`)
- Gate playground: `playground.html` next to the board (run `npm run demo:mock` to build it locally)

## Inspiration

Code generation is solved; code *deletion* isn't. Every team carries routes nobody calls, flags nobody flips and packages nobody imports, and each one costs image size, cold starts and carbon. Nobody lets an agent remove them, because "dead" code sometimes has one caller a month. And nobody lets an agent ship to production alone, because agent autonomy today is a setting you pick once and hope about.

We wanted the opposite: **autonomy as something an agent earns in production, zone by zone, and loses the moment it breaks something.**

## What it does

Two halves, both on GitLab:

**Undertaker** is a GitLab Duo Agent Platform flow that can only delete, and only what production proves is dead.
- A nightly **census** reads Tallybook's Cloud Run request logs and files a 🪦 issue for each route with zero traffic in the window, each flag that never changed, each unused dependency and each orphan export, with its evidence (request counts, window, zone).
- Undertaker **exhumes** (reads the issue and the code), **buries** (opens one minimal deletion MR with an epitaph, the evidence and `Closes #n`), then acts as its own **coroner**: it searches for live references to everything it removed and labels the MR `coroner::objection` if it finds one.

**Probation** is the deterministic CI system that decides how far each of Undertaker's MRs goes without a human.

| Level | Trust score in the zone | What the pipeline lets the agent do |
|---|---|---|
| **Assisted** | < 10 | Opens an MR; a human merges and approves production |
| **Supervised** | ≥ 10 | The gate sets auto-merge; a human clicks `approve:production` |
| **Hands-off** | ≥ 30 | Issue → MR → merge → 10% canary → production, no human |

- Trust is scored **per code zone** (legacy, flags, deps, routes, core): earned from deploys that survive a 10% production canary soak (+10), and lost on rollback (−40), human rejection (−20) or a new security finding (−30). An MR spanning zones gets the level of its least-trusted zone.
- The agent can't merge, can't touch auth, CI or its own policy, can't add code and can't add or edit tests. The gate enforces this in TypeScript, not in a prompt, and `policy.yml` is protected by CODEOWNERS.
- The **Probation Clerk**, a read-only custom Duo agent, answers "why is the routes zone still Assisted?" in Duo Chat from `policy.yml` and the ledger, citing the MRs behind each score. A probation MCP server gives Duo Agentic Chat in the IDE the same answers (`get_trust`, `list_graves`, `explain_gate`, `policy`).
- The **Probation Board** (GitLab Pages) shows every zone's level and history, with an animated ledger replay and a **gate playground** where anyone can move the scores and watch the real gate code decide.

**The demo.** Undertaker climbs from Assisted to Hands-off in the legacy zone, then buries `GET /api/v1/export.csv`: zero hits in seven days. But a bookkeeping partner calls it on the 1st of every month. During the canary soak, that partner's synthetic check gets a 404 and the canary's own request logs show a hit on a deleted route. Traffic rolls back, the commit is reverted, Undertaker drops straight back to Assisted, and the grave is marked do-not-bury forever. Nobody had to be watching. Autonomy you can earn, and lose.

**Why a platform team would want it.** Teams already accept autonomous changes from Dependabot-style bots; what they lack is a way to *grant more* autonomy safely. Probation turns "do we trust the agent?" into a reviewed policy file, an audit trail and a per-zone score that anyone can query, and the same ledger can hold a second agent tomorrow.

## How we built it

![Architecture](media/diagrams/architecture.png)

- **The agent proposes; the pipeline disposes.** Undertaker is a custom flow (`flows/undertaker.yml`: three `AgentComponent`s, `coding_environment: none`, GitLab API tools only). A scheduled CI job starts it through the Flows API, and the `catalog-sync` CI component publishes it to the AI Catalog.
- **The gate is code, not a prompt.** `probation/src/gate.ts` is a pure function of the policy, the ledger and the MR diff. It returns one of four verdicts (block, needs a human, merge at Supervised, merge at Hands-off), posts a note citing the rule, labels the MR `probation::<level>` and `zone::<zones>`, and sets auto-merge when the level allows. The gate playground bundles the same `gate.ts` for the browser, so it never re-implements a rule.
- **The release pipeline is generated.** On main, `release:plan` writes a child pipeline shaped by the verdict: at Supervised it contains a manual `approve:production`; at Hands-off it doesn't. Cloud Run revision tags and traffic splits give staging (0% traffic), canary (10%) and rollback without a second service.
- **The ledger is a branch.** `ledger.json`, an append-only `audit.jsonl` and `traffic.json` live on a `ledger` branch; every writer takes `resource_group: ledger`. The board, the Clerk and the MCP server all read from it.
- **The census is honest about its blind spot.** A 7-day window can't see a monthly client, so `probation/synthetics.yml` lists known long-period clients and the soak replays them against the canary. In parallel, `soak:canary-logs` reads the canary revision's real requests and `soak:canary-signal` fails on a 5xx rate or deleted-route hits above the previous revision's baseline. A failed synthetic triggers `rollback:soak` at once, and the rollback becomes a learning signal (`undertaker::do-not-bury`).
- **Tested without the cloud.** Gate, ledger, census, SCI, board, replay and playground are pure modules with 170+ Vitest tests. An end-to-end suite runs the real CI entry points against a local GitLab API simulator (`probation/sim/`). Flow and agent YAML are validated against the AI Catalog schemas (`validate-items`). A docs check (`node scripts/check-docs.ts`) fails CI if this text names a job, file, script or threshold the code doesn't have.
- **Operated from the terminal.** `npm run gitlab:setup` creates labels, schedule, protected tag and MR settings idempotently; `npm run doctor` is a read-only preflight before any credits are spent; `npm run demo` drives each live act; `npm run demo:mock` plays all five acts offline; `npm run submission` fills this file's placeholders from the live ledger and MR notes.

### All nine DevSecOps stages

![Nine stages](media/diagrams/stages.png)

| Stage | Jobs | What runs |
|---|---|---|
| Plan | `census:collect`, `census:file`, `undertaker:dig` | Production logs → labelled candidate issues; one is picked and the flow started |
| Create | Undertaker flow: `exhume` → `bury` → `coroner` | A minimal deletion MR with evidence, then an adversarial self-review |
| Verify | `verify:check`, `verify:replay`, `validate-items` | Lint, typecheck, tests; a **traffic replay** (every route that served production must still answer); catalog schema check |
| Package | `package:image`, `catalog-sync` | Cloud Build → Artifact Registry image per commit; flow and Clerk published to the AI Catalog |
| Secure | SAST, Secret Detection, Dependency Scanning; `secure:npm-audit` | Findings diffed against main by the gate; a new one blocks the MR and costs −30 |
| Release | `release:plan`, `release:run` → `deploy:staging` → `approve:production` → `deploy:canary` → `promote:production`; `govern:release-notes` | A child pipeline shaped by the earned level; a GitLab Release per deploy |
| Configure | `ci/deploy.sh`, `ci/gcp-auth.sh`, `probation/policy.yml`, `npm run gitlab:setup` | Revision tags, traffic splits, per-revision flag env and Secret Manager; keyless Workload Identity Federation; autonomy itself as reviewed config |
| Monitor | `soak:canary`, `soak:canary-logs`, `soak:canary-signal`, `rollback:soak`, `rollback:production`, `measure:sci` | Synthetic clients for 3 minutes; the canary's real 5xx rate and deleted-route hits; automatic rollback; SCI per MR |
| Govern | `probation:gate`, `settle:survived`, `settle:rolled-back`, `probation:sweep`, `govern:baseline`, `pages` | `policy.yml` + CODEOWNERS; append-only ledger; 🎖️ promotion and ⬇️ demotion issues; the board; the Clerk and MCP server |

Per-job evidence: `docs/STAGES.md`.

### Honest status

What is real and runs today: the full `.gitlab-ci.yml` (MR, main, release-child and schedule pipelines), the gate, the ledger, the census, SCI measurement, the board, replay and playground, the Tallybook container image (`app/Dockerfile`, built and measured locally), the schema-validated flow and agent, and 170+ tests including the end-to-end suite of the real CLIs against the GitLab simulator.

What has **not** been executed yet: the live Google Cloud deploy and the live Duo flow runs. Everything above was built and tested against the local GitLab API simulator and an offline mock ledger. Until live runs exist, the Pages board carries an "Offline rehearsal" banner, and the fallback video `docs/media/demo-rough-cut.mp4` is labelled offline rehearsal. The scripted production outcomes in that rehearsal go through the same gate and ledger code the pipeline uses.

## Environmental impact (Most Environmentally Impactful)

Every MR and main pipeline measures Tallybook with the Green Software Foundation's **Software Carbon Intensity** specification (ISO/IEC 21031:2024):

```text
SCI = ((E × I) + M) per R        R = 1,000 HTTP requests served
```

**Measured on every pipeline (`measure:sci`, `probation/src/cli/sci.ts`):** cold start (spawn → healthy); CPU time (`utime + stime` from `/proc`) and sampled RSS while autocannon drives a fixed request mix (10 connections, 10 s); deployable size (`app/src` plus production `node_modules`).

**Converted to carbon** (coefficients in `probation/sci-coefficients.yml`, checked against the Cloud Carbon Footprint methodology on 2026-10-26):
- **E** = compute (CPU-hours × 4.26 W per vCPU) + memory (GB-hours × 0.000392 kWh) + image transfer (GB × 0.001 kWh × 1 cold start per 1k requests) + cold start (seconds × 4.26 W), all × PUE 1.1.
- **I** = **432 gCO₂e/kWh**, the location-based grid intensity of `us-central1` (Iowa) in Google's 2025 region data (431.95 unrounded, 88% CFE).
- **M** = 0.713 g per vCPU-hour of reserved time (1,200 kgCO₂e host embodied emissions over 4 years and 48 vCPUs; the host figures are our stated assumptions).

**What we claim, and what we don't:** deleting dead code barely moves per-request CPU. It shrinks the image every cold start pulls and the module loading at boot. The 🌱 MR note shows each component, main vs MR, so the saving is visible where it is real. In the built container, `moment` and `lodash` are 5.9 MB of the 16.0 MB of production `node_modules` (37%); the deployable size `measure:sci` counts (`du -sk app`) drops from 25.9 to 15.7 MB without them (measured locally on 2026-10-27).

**Measured results:**
- ✏️ Dependency burial (moment + lodash): app layer ✏️ X MB → ✏️ Y MB, cold start ✏️ a ms → ✏️ b ms, SCI ✏️ −X% (copy from that MR's 🌱 note).
- ✏️ All burials since the first measurement: SCI ✏️ −X% (board stat "SCI change").
- ✏️ Optional scale-up: at ✏️ N requests a month, that is ✏️ g CO₂e a year (show the arithmetic).

**Designed for low energy:** the flow uses `coding_environment: none` (no clone, no runner); one small candidate per run; Cloud Run scales to zero on 256 MiB instances; no build step (Node runs the TypeScript directly); tag pipelines run only `catalog-sync`; the release image is `node:22.23-slim` plus production dependencies, running as the unprivileged `node` user.

Method and limits (CPU watts are an estimate, results are comparative, CI minutes not counted): `docs/SCI.md`.

## Challenges we ran into

- **Agents can't merge, and pipeline triggers ignore bots.** That pushed us to the better design: the *pipeline* holds the power and the agent only proposes. The Flows API needs a person's token, so only the scheduled job on `main` calls it.
- **The flow schema is stricter than the runtime.** The AI Catalog validates flows against the registry v1 schema, which rejects `max_cycles` even though the runtime accepts it. We kept the flow schema-valid and capped work by design: one candidate per run.
- **A census can't see clients slower than its window.** Rather than pretend otherwise, we made the canary soak the backstop and turned the rollback into a learning signal (do-not-bury plus demotion).
- **Concurrent pipelines, one ledger.** Two settle jobs writing the same JSON would lose an event. Every ledger writer shares `resource_group: ledger`, and only one release child pipeline runs at a time (`resource_group: production`).
- **Measuring carbon without a power meter.** We measure what a CI runner can (CPU time, RSS, size, cold start), use published coefficients, and say where the estimate is weak.
- **Building the live loop before having the live environment.** The Google Cloud deploy and the Duo flow runs are not executed yet, so we wrote a GitLab API simulator and an offline mock ledger and drove every CLI end to end against them. The board and the fallback video say "offline rehearsal" until the live runs replace them.

## Accomplishments that we're proud of

- An agent whose autonomy is a number in a reviewed file, earned in production and visible to everyone.
- A rollback that teaches: one failed soak demotes the agent, reverts the change and makes sure that grave is never dug again.
- All nine stages covered by jobs that do real work, plus a docs check that keeps every job name and threshold in these docs true to the code.
- A gate you can play with: the playground runs the exact gate code from CI in the browser.

## What we learned

- Trust in an agent is a per-area, per-history property, not a global toggle. Zones made the levels believable.
- The most useful LLM step was the one that attacked its own output. The coroner is cheap and catches what exhume missed.
- Permission decisions belong in deterministic code. The LLM never decides what merges or ships.
- Carbon claims are only worth making when they are specific: most of a deletion's saving is image size and cold start, not CPU.

## What's next

- Run the live Google Cloud and Duo acts and replace the offline rehearsal with the real ledger.
- Several agents on probation side by side (a test-writer next to Undertaker), each with its own ledger.
- Latency signals in the soak, next to the synthetics and the canary's error rate.
- Org-wide trust that transfers between projects with similar zones.
- Real-world thresholds (about 10× the demo's soak and scores).

## Image gallery

Upload in this order (all PNG, 16:9 or wider where possible):
1. `docs/media/cards/png/01-hook.png`: title card.
2. `docs/media/diagrams/architecture.png`: the whole system.
3. `docs/media/cards/png/02-ladder.png`: the autonomy ladder.
4. `docs/media/board-light.png`: the Probation Board after the five acts (offline rehearsal).
5. `docs/media/cards/png/03-rollback.png`: the demotion.
6. `docs/media/playground.png`: the gate playground.
7. `docs/media/diagrams/stages.png`: the nine stages with their job names.
8. `docs/media/cards/png/04-stages.png`: stages card from the video.
9. `docs/media/board-dark-mobile.png`: the board on a phone, dark mode.
10. `docs/media/cards/png/05-end.png`: closing card.
11. ✏️ Screenshots from the live project: the gate note at Hands-off, the `soak:canary` 404 log, Cloud Run revisions with traffic split, a 🌱 SCI note.
12. `docs/media/replay-frames/03.png`: the ledger replay at the rollback.

## Built with

gitlab, gitlab-ci, gitlab-duo-agent-platform, gitlab-ai-catalog, gitlab-pages, mcp, google-cloud-run, cloud-build, artifact-registry, cloud-logging, secret-manager, typescript, node.js, fastify, vitest, biome, esbuild
