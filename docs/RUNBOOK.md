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
   - Paste the YAML into the definition editor and save. The editor validates the schema.
   - If it rejects a key, fix it there and copy the fix back into `flows/undertaker.yml`. The docs disagree on v1 vs `flow_v2` validation.
3. **Enable** the flow on this project. GitLab creates a service account named like `ai-undertaker-<group>`. In the dialog, also add triggers **Assign** and **Mention**; they are the fallback (§5).
4. Find the consumer ID. Open `https://gitlab.com/-/graphql-explorer` and run:
   ```graphql
   query { aiCatalogConfiguredItems(projectId: "gid://gitlab/Project/<numeric project id>") { nodes { id item { name } } } }
   ```
   The number at the end of the `id` (`gid://gitlab/Ai::Catalog::ItemConsumer/<N>`) is `UNDERTAKER_CONSUMER_ID`. If the field name differs, use the explorer's autocomplete on `aiCatalog`.

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

**If a flow run goes wrong:** remove the `undertaker::in-progress` label from the issue, close the bad MR, and run again. A failed flow costs no credits.

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
