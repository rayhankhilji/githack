# Devpost submission draft

> Replace every line marked ✏️ before you submit. Pick the final name yourself (the FAQ asks for a human-chosen name). "Probation" is a working title.

**Name:** Probation ✏️
**Tagline:** An AI that deletes dead code, and has to earn the right to ship it.
**Path:** A: Start Fresh · **Category:** Hands-off · **Special:** Most Environmentally Impactful (opt-in)
**Links:**
- ✏️ GitLab repo
- ✏️ Tallybook on Cloud Run
- ✏️ Probation Board (GitLab Pages)
- ✏️ YouTube video

## What it does

Code generation is solved; code *deletion* isn't. Nobody lets an agent remove code, because "dead" code sometimes has one caller a month. And nobody lets an agent ship to production alone, because autonomy today is a setting you pick and hope.

**Undertaker** is a GitLab Duo Agent Platform flow that can only delete:
- A nightly **census** reads Cloud Run request logs and files a 🪦 issue for every route with zero traffic, flag that never changes, unused dependency, and orphan export. Each issue carries its evidence.
- Undertaker investigates (**exhume**), opens one minimal deletion MR with the evidence and an epitaph (**bury**), then attacks its own work (**coroner**). The coroner blocks the MR if it finds a live reference.

**Probation** is the deterministic CI system that decides how far each MR goes alone:
- Trust is earned **per code zone**, from deploys that survive a production canary soak (+10), and lost on rollback (−40), human rejection (−20) or a new security finding (−30).
- **Assisted** (a human approves) → **Supervised** (auto-merge; a human approves production) → **Hands-off** (from issue to production with no human).
- The agent can't merge, can't touch auth or CI, can't edit its own policy, and can't add code or tests. The gate enforces all of it in code, not in a prompt.

**In the demo, Undertaker goes all the way from Assisted to Hands-off, then breaks a monthly partner export.** The canary soak catches the 404, traffic rolls back, the commit is reverted, Undertaker is demoted, and that grave is marked do-not-bury forever. Autonomy you can earn, and lose.

## How we built it (all nine DevSecOps stages)

| Stage | What runs |
|---|---|
| Plan | `census:file` turns production logs into labelled candidate issues (zone, kind, evidence) |
| Create | Undertaker flow (custom Duo flow, 3 agent components, API-only tools) opens the deletion MR |
| Verify | Lint, typecheck, 40 tests, plus a **traffic replay**: every route that served production traffic must still exist |
| Secure | GitLab SAST, Secret Detection and Dependency Scanning templates, plus an npm-audit findings diff against main's baseline in the gate |
| Package | Cloud Build → Artifact Registry image per commit |
| Release | A dynamic child pipeline shaped by the gate's verdict: staging revision → (approval) → 10% canary → soak → promote or roll back; GitLab Release |
| Configure | Cloud Run revision tags, traffic splits and feature-flag env per revision, all from CI; keyless GitLab → GCP auth (Workload Identity Federation) |
| Monitor | Structured census logs in Cloud Logging; synthetic production monitors during the soak |
| Govern | `policy.yml` + CODEOWNERS (humans own the leash), an append-only ledger and `audit.jsonl` on a `ledger` branch, promotion and demotion issues, and a public Probation Board on Pages |

**Stack:** TypeScript on Node 22 (no build step), Fastify, Vitest, Biome, GitLab CI, GitLab Duo Agent Platform (custom flow, Flows API, AI Catalog), Cloud Run, Cloud Build, Artifact Registry, Cloud Logging, Secret Manager.

## Sustainability (Most Environmentally Impactful)

Every MR is measured with the Green Software Foundation **SCI** spec (ISO/IEC 21031:2024): SCI = (E·I + M) per 1,000 requests.
- **E:** measured CPU time and RSS under a fixed load mix, cold-start time and app-layer size, using Cloud Carbon Footprint coefficients.
- **I:** grid intensity for the Cloud Run region.
- **M:** embodied emissions amortised per vCPU-hour.

The before/after is posted on each MR and tracked on the board. Method and limits: `docs/SCI.md`.

**Measured results:**
- ✏️ The dependency burial (moment + lodash) cut the app layer from about 16 MB to about 5.6 MB and SCI by ✏️ X% (copy from that MR's 🌱 note).
- ✏️ Total since the first measurement: X% (board).

**Design choices for low energy:**
- The flow uses `coding_environment: none`: no repo clone, no runner setup, API tools only.
- One small candidate per run, with `max_cycles` caps.
- Cloud Run scales to zero, with 256 MiB instances.
- Node runs TypeScript natively, so there is no build step and no build artifacts.

## Challenges

- Agents can't merge, and triggers ignore bots. That pushed us to the better design: the *pipeline* holds the power, and the agent only proposes.
- A census can't see clients slower than its window. Rather than pretend otherwise, we made the canary soak the backstop and turned the rollback into a learning signal (do-not-bury and demotion).

## What's next

- Several agents on probation side by side (a test-writer next to Undertaker).
- Error-rate soak signals from Cloud Monitoring.
- Org-wide trust that transfers between projects with similar zones.

## Built with

gitlab, gitlab-duo-agent-platform, gitlab-ci, google-cloud-run, cloud-build, artifact-registry, cloud-logging, secret-manager, typescript, node.js, fastify, vitest
