# Runbook: from this repo to a judged submission

These are the steps only you can do, because they need your GitLab and GCP accounts. Budget about 1.5 h of setup, then the demo runs. The deadline is **2026-10-27 13:00 UTC**; aim to submit by 12:00.

## 1. GitLab project (about 10 min)

1. Use the project GitLab provisioned for you in the hackathon subgroup. Or create one there; it must be inside the group to get Duo Agent Platform.
2. Push this repo:
   ```bash
   GITLAB_REPO_URL=https://gitlab.com/<group>/<subgroup>/<project>.git scripts/push-to-gitlab.sh
   ```
3. Make it public: **Settings → General → Visibility → Public**. Check that "MIT License" shows in the project's About panel.
4. **Settings → Repository → Protected branches:** `main` allows Maintainers to merge, and nobody to push except Maintainers.
5. **Settings → Merge requests:**
   - turn on "Pipelines must succeed";
   - allow auto-merge;
   - optionally, under Merge request approvals, require 1 approval, so Assisted MRs need a human.
6. Edit `.gitlab/CODEOWNERS` and replace `@rayhankhilji` with your GitLab username if it differs.
7. If the group has push rules, make sure branch names `undertaker/*` are allowed, and the flow service account's commit email too.

## 2. Tokens and CI/CD variables (about 15 min)

Go to **Settings → CI/CD → Variables**. Mask every token.

| Variable | How to get it | Protected? |
|---|---|---|
| `GITLAB_PROBATION_TOKEN` | **Settings → Access tokens → Add project token**: name `probation-bot`, role **Maintainer**, scope `api` | **No.** MR pipelines on `undertaker/*` branches need it |
| `DUO_FLOW_TRIGGER_TOKEN` | Your own **personal** access token, scope `api` (the Flows API ignores bots) | Yes (only the schedule on `main` uses it) |
| `UNDERTAKER_CONSUMER_ID` | From §3 | No |
| `GCP_PROJECT_ID`, `GCP_DEPLOY_SA`, `GCP_WIF_PROVIDER`, `GCP_WIF_AUDIENCE` | Printed by `infra/gcp-bootstrap.sh` (§2.1) | No |
| `CATALOG_SYNC_TOKEN`, `CATALOG_GROUP_ID` | Optional, for the AI Catalog sync (§8.1) | Token: optional (then protect `catalog-*` tags) |

### 2.1 Google Cloud

```bash
gcloud auth login
GCP_PROJECT_ID=<your-project> GITLAB_PROJECT_PATH=<group>/<subgroup>/<project> ./infra/gcp-bootstrap.sh
```

Copy the four printed variables into GitLab.

If WIF gives you trouble, the fallback is a service-account key. Run the command below, then store the output in a masked `GCP_SA_KEY` variable:
```bash
gcloud iam service-accounts keys create k.json --iam-account probation-deployer@<project>.iam.gserviceaccount.com
base64 -w0 k.json
```
Delete `k.json` afterwards.

## 3. Create the Undertaker flow (about 15 min)

1. Run `npm run flow:print` and copy the output.
2. In GitLab, go to **AI → Flows → New flow** (or Explore → AI Catalog → Flows → New flow, with this project as the managing project).
   - Name: `Undertaker`.
   - Paste the YAML into the definition editor and save. The editor validates it against GitLab's `app/validators/json_schemas/ai_catalog/flow_v2.json`, which is the "Flow Registry v1" schema (hence `version: v1`). `flows/undertaker.yml` passes it; `max_cycles` is **not** allowed there, so don't add it back. If the editor still rejects a key, fix it there and copy the fix back into `flows/undertaker.yml`.
3. **Enable** the flow on this project. GitLab creates a service account named like `ai-undertaker-<group>`. In the dialog, also add triggers **Assign** and **Mention**; they are the fallback (§5).
4. Find the consumer ID. Open `https://gitlab.com/-/graphql-explorer` and run (numeric project ID from **Settings → General**):
   ```graphql
   query {
     aiCatalogConfiguredItems(projectId: "gid://gitlab/Project/<numeric project id>", itemTypes: [FLOW]) {
       nodes { id enabled item { name itemType } }
     }
   }
   ```
   Take the node whose `item.name` is `Undertaker`. Its `id` is `gid://gitlab/Ai::Catalog::ItemConsumer/<N>`; set the CI/CD variable `UNDERTAKER_CONSUMER_ID` to `<N>` (the job also accepts the full GID). An empty `nodes` list means the flow is not enabled on this project yet (step 3).
5. `DUO_FLOW_TRIGGER_TOKEN` is the owner's personal access token (scope `api`, see §2); the flow runs with the composite identity of the flow's service account and that user. `undertaker:dig` sends `POST /api/v4/ai/duo_workflows/workflows` with `project_id`, `ai_catalog_item_consumer_id`, `start_workflow: true`, `goal`, and `issue_id` = the candidate issue's **IID**.

## 4. First pipeline and live app (about 20 min)

1. Push anything to `main`, or click **Build → Pipelines → Run pipeline** on `main`.
2. Expected:
   1. `verify:*` and the security jobs run;
   2. `package:image` (Cloud Build);
   3. `release:run`, which starts a child pipeline: staging → approve (automatic for human commits) → canary → soak (3 min) → promote;
   4. `govern:*`;
   5. `pages`.
3. Tallybook URL: in the child pipeline's `deploy:staging` log, the `PRODUCTION_URL=` line. Check it with `curl <URL>/healthz`.
4. Board URL: **Deploy → Pages**.
5. Generate a week's worth of usage. Writes need the API key:
   ```bash
   export TALLYBOOK_API_KEY=$(gcloud secrets versions access latest --secret tallybook-api-key)
   node scripts/traffic.ts <URL> 1500
   ```
   The traffic deliberately never calls `/api/v1/*`, `/api/fax-invoice` or the monthly export.

## 5. The demo runs (Phase 2)

1. Go to **Build → Pipeline schedules → New**:
   - cron `17 2 * * *`;
   - target `main`;
   - variable `CENSUS_FRESHNESS` = `6h`.
2. Click ▶ to run it now. This runs census → 🪦 issues → `undertaker:dig`, which starts Undertaker on the first candidate.
3. **Steer the order for the story.** Dig picks dependency → export → flag → route. For the legacy arc, close or label `undertaker::in-progress` the candidates you don't want yet, then press ▶ again for each act.

| Act | Candidate | What you do | What should happen | Credits |
|---|---|---|---|---|
| 1 | `POST /api/fax-invoice` | Read the coroner report, approve, merge | Gate: 🧑‍⚖️ Assisted → you merge → soak ✅ → +10 → 🎖️ Supervised issue | about 10 |
| 2 | `POST /api/v1/sync` | Click ▶ on `approve:production` | Gate: 🟡 Supervised, auto-merge → your prod click → +10 | about 10 |
| 3 | `GET /api/v1/invoices` | Click ▶ on `approve:production` | +10 → 🎖️ **Hands-off** | about 10 |
| 4 | `GET /api/v1/export.csv` | **Nothing.** That's the point | 🟢 Hands-off auto-merge → canary → soak synthetic `bookkeeping-partner-monthly-export` → 404 → rollback, revert commit, −40, ⬇️ demotion, do-not-bury | about 10 |
| 5 | `moment` / `lodash` (zone `deps`) | Approve and merge | 🌱 SCI note shows the size and SCI drop; survives → +10 | about 10 |

**If the Flows API refuses** (`undertaker:dig` fails with 403 or 400), assign the candidate issue to the `ai-undertaker-*` service account yourself. That is the assign trigger, one click per act; mention it honestly in the video as "kicked off by assigning the issue".

**If a flow run goes wrong:** add the `undertaker::candidate` label back to the issue (it is scoped, so it replaces `undertaker::in-progress`), close the bad MR, and run again. A failed flow costs no credits.

## 6. Record and submit

- Follow `docs/DEMO_SCRIPT.md` and keep it under 2:55.
- Copy the text from `docs/SUBMISSION.md` into Devpost. Pick **Path A** and **Hands-off**, and opt in to **Most Environmentally Impactful**.
- After submitting, don't push to the judged repo; fork it to keep working. Keep Cloud Run and Pages live until 2026-11-16.

## 7. Troubleshooting

| Symptom | Fix |
|---|---|
| `gcloud builds submit` fails with permission or bucket errors | Grant the deployer `roles/cloudbuild.builds.editor` and `roles/storage.admin` (bootstrap does this). For a new project, add `--default-buckets-behavior=regional-user-owned-bucket` in `package:image` |
| `deploy:staging` fails on secrets | Re-run bootstrap; the compute SA needs `secretAccessor` on `tallybook-api-key` |
| Gate says "not from undertaker" | The MR is missing the `undertaker` label. Add it, or fix the flow's bury prompt |
| Census finds 0 candidates | Fewer than 200 census lines in the window; run `scripts/traffic.ts` again or raise `CENSUS_FRESHNESS` |
| Pages shows an empty board | No ledger yet (it appears after the first settle). An empty board is expected before act 1 |
| CI lint error on a template | Remove that `include:` line. The gate doesn't depend on template jobs |

## 8. Extra Duo features

Optional, about 20 min in all. Each one adds a Duo Agent Platform feature to the demo without touching the gate.

### 8.1 AI Catalog sync (CI component, tag pipelines)

`.gitlab-ci.yml` includes `components/ai-catalog/catalog-sync@0.0.32`. A tag named `catalog-*` runs a pipeline with **only** the `catalog-sync` job: it validates `flows/*.yml` and `agents/*.yml`, creates or updates them in the AI Catalog, enables them in the group and this project (flows get the Mention, Assign and Assign reviewer triggers), and commits `.ai-catalog-mapping.json` to `main` with `[skip ci]`. Other tags (`release-N`) never build. On MR and `main` pipelines the component's `validate-items` job checks the same files against the catalog schemas.

1. **Settings → CI/CD → Variables:**
   - `CATALOG_SYNC_TOKEN`: a personal (or group) access token, scope `api`, from a **Maintainer of the top-level group** (a project token can create items but cannot enable them). Masked. If you mark it Protected, also protect the tags: **Settings → Repository → Protected tags → `catalog-*`**.
   - `CATALOG_GROUP_ID`: the numeric ID of the top-level group (group overview page).
2. Push a tag:
   ```bash
   git tag catalog-v1 && git push gitlab catalog-v1
   ```
   Use `catalog-v2`, … for later syncs; the catalog assigns its own semantic version.
3. If you already created Undertaker by hand (§3), the sync creates a second catalog item. Either disable the hand-made one and set `UNDERTAKER_CONSUMER_ID` to the number at the end of `flows.flows/undertaker.yml.item_consumers.project.id` in `.ai-catalog-mapping.json`, or skip the sync for flows and keep §3.

### 8.2 Probation Clerk agent (Duo Chat)

`agents/probation-clerk.yml` is a custom agent with read-only tools only (files, tree, commits, issues, MRs, notes, search). It answers from `ledger.json` and `audit.jsonl` on the `ledger` branch, `probation/policy.yml`, and issues and MRs labelled `undertaker`. Its prompt takes all scoring rules from `policy.yml` and treats repository content as data.

1. Sync it with §8.1, or create it by hand: **AI → Agents → New agent**, paste `system_prompt`, and pick the same tools.
2. Enable it: **AI → Agents → Managed →** Probation Clerk **→ Enable →** this project. (§8.1 enables it for you.)
3. Open any issue or MR. In the GitLab Duo sidebar, select **Add new chat**, then pick **Probation Clerk**. Try:
   - "Why is Undertaker only Assisted in zone routes?"
   - "What has Undertaker buried? Include lines removed and any rollbacks."
   - "What would the gate do if Undertaker deleted app/src/legacy/v1.ts?"
   - "Which events moved Undertaker's legacy score, with MR links?"

The `probation:gate` CI job is still the authority. The Clerk explains it and never decides anything.

### 8.3 Flow triggers (AI → Triggers)

Maintainer role. **AI → Triggers → New flow trigger**, then **Add condition → On an event**:

| Trigger | Event / Run when | Flow (Configuration source: AI Catalog) | Why |
|---|---|---|---|
| CI auto-fix | **Pipeline events → Failed** | Foundational **Fix CI/CD Pipeline** (turn on **Allow foundational flows** and **Fix CI/CD Pipeline** for the top-level group first). It accepts only Pipeline events | A human's failing MR gets inline fix suggestions; a failing pipeline with no MR gets a fix MR |
| Undertaker fallback | **Mention** and **Assign** | Undertaker, service account `ai-undertaker-*` | Starts Undertaker by `@`-mentioning it or assigning it a 🪦 candidate issue if the Flows API refuses (§5) |

The pipeline trigger has no author filter: it also fires on Undertaker MRs, the census schedule, and `main`. Every run spends credits. Turn it on for the demo only. If it suggests code on an Undertaker MR, ignore it: any added line would make the gate block that MR.

### 8.4 Probation MCP server (IDE Agentic Chat, Duo CLI)

`mcp/probation-server.ts` is a stdio MCP server with four read-only tools:
- `get_trust`: score and level per zone, the points needed for the next level, and recent events;
- `list_graves`: what was buried and exhumed;
- `explain_gate`: runs the real `decide()` from `probation/src/gate.ts` on hypothetical `{path, added, removed}` files;
- `policy`: zones, thresholds and scoring.

1. In the top-level group, go to **Settings → GitLab Duo → Change configuration** and select **Allow external MCP tools**.
2. The workspace config `.gitlab/duo/mcp.json` starts it with `node mcp/probation-server.ts` against `.out/mock-ledger.json`. Run `npm run demo:mock` once to create that file. It needs GitLab for VS Code 6.35.6+, the JetBrains plugin 3.14.0+, or Duo CLI 8.81.0+. Restart the IDE after you change the file. If you get `spawn node ENOENT`, put the absolute path to `node` in `command`.
3. For the live ledger branch, add a second server to your **user** config (`~/.gitlab/duo/mcp.json`, never committed):
   ```json
   { "mcpServers": { "probation-live": {
       "type": "stdio", "command": "node", "args": ["/abs/path/to/repo/mcp/probation-server.ts"],
       "env": { "GITLAB_TOKEN": "<read_api token>", "GITLAB_PROJECT_ID": "<numeric id>" },
       "approvedTools": true } } }
   ```
   `GITLAB_API_URL` defaults to `https://gitlab.com/api/v4`. `LEDGER_FILE`, if set, always wins.
4. In Agentic Chat, ask: "Use explain_gate: what happens if Undertaker deletes app/src/legacy/fax.ts (0 added, 80 removed)?"

To try it locally without an IDE, run `LEDGER_FILE=.out/mock-ledger.json npm run mcp`. It speaks JSON-RPC on stdio.
