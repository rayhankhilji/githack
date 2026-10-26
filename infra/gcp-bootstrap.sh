#!/usr/bin/env bash
# One-time Google Cloud setup for Tallybook + Probation. Run locally with gcloud logged in as a project owner:
#   GCP_PROJECT_ID=my-project GITLAB_PROJECT_PATH=group/subgroup/project ./infra/gcp-bootstrap.sh
# Creates: Artifact Registry repo, deploy service account, keyless GitLab → GCP federation (OIDC),
# the API-key secret, and prints the CI/CD variables to add in GitLab.
set -euo pipefail
: "${GCP_PROJECT_ID:?set GCP_PROJECT_ID}"
: "${GITLAB_PROJECT_PATH:?set GITLAB_PROJECT_PATH, e.g. gitlab-transcend/team/tallybook}"
REGION="${GCP_REGION:-us-central1}"
SA_NAME=probation-deployer
SA="$SA_NAME@$GCP_PROJECT_ID.iam.gserviceaccount.com"
POOL=gitlab-pool
PROVIDER=gitlab-com
# Regional builds (`--region us-central1`) still stage source in the multi-region gs://PROJECT_cloudbuild bucket
# by default. If an org policy restricts resource locations, add
# `--default-buckets-behavior=regional-user-owned-bucket` to `gcloud builds submit`.
gcloud config set project "$GCP_PROJECT_ID"
PROJECT_NUMBER=$(gcloud projects describe "$GCP_PROJECT_ID" --format='value(projectNumber)')

# compute.googleapis.com creates the Compute Engine default service account, which new projects use
# both as the Cloud Run runtime identity and as the default Cloud Build service account.
gcloud services enable compute.googleapis.com run.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com \
  logging.googleapis.com secretmanager.googleapis.com iamcredentials.googleapis.com sts.googleapis.com

gcloud artifacts repositories describe tallybook --location "$REGION" >/dev/null 2>&1 ||
  gcloud artifacts repositories create tallybook --repository-format docker --location "$REGION"

gcloud iam service-accounts describe "$SA" >/dev/null 2>&1 ||
  gcloud iam service-accounts create "$SA_NAME" --display-name "Probation CI deployer"
# roles/viewer: `gcloud builds submit` streams logs from the default Cloud Storage logs bucket, which
#   Cloud Build only allows for Viewer/Owner; without it the build runs but the command exits 1.
# roles/storage.admin: create/upload to the gs://PROJECT_cloudbuild source bucket.
# roles/iam.serviceAccountUser: act as the default compute SA (Cloud Run runtime and Cloud Build SA).
for role in roles/run.admin roles/iam.serviceAccountUser roles/artifactregistry.writer \
  roles/cloudbuild.builds.editor roles/logging.viewer roles/viewer roles/storage.admin \
  roles/serviceusage.serviceUsageConsumer; do
  gcloud projects add-iam-policy-binding "$GCP_PROJECT_ID" --member "serviceAccount:$SA" --role "$role" --condition=None >/dev/null
done

# The app reads its write API key from Secret Manager.
if ! gcloud secrets describe tallybook-api-key >/dev/null 2>&1; then
  openssl rand -hex 24 | gcloud secrets create tallybook-api-key --data-file=-
fi
COMPUTE_SA="$PROJECT_NUMBER-compute@developer.gserviceaccount.com"
# Cloud Build runs as the Compute Engine default SA in projects created since mid-2024 (older projects keep
# the legacy PROJECT_NUMBER@cloudbuild.gserviceaccount.com). Under the iam.automaticIamGrantsForDefaultServiceAccounts
# org policy that SA has no roles, so grant what a docker build + push needs: read the uploaded source,
# write logs, push to Artifact Registry.
BUILD_SA=$(gcloud builds get-default-service-account --format='value(serviceAccountEmail)' 2>/dev/null || true)
BUILD_SA="${BUILD_SA##*/}"
BUILD_SA="${BUILD_SA:-$COMPUTE_SA}"
for role in roles/storage.objectViewer roles/logging.logWriter roles/artifactregistry.writer; do
  gcloud projects add-iam-policy-binding "$GCP_PROJECT_ID" --member "serviceAccount:$BUILD_SA" --role "$role" --condition=None >/dev/null
done
# Cloud Run runtime SA (default compute SA) reads the API key.
gcloud secrets add-iam-policy-binding tallybook-api-key --member "serviceAccount:$COMPUTE_SA" \
  --role roles/secretmanager.secretAccessor >/dev/null

# Keyless auth: only pipelines of this GitLab project can impersonate the deployer.
gcloud iam workload-identity-pools describe "$POOL" --location global >/dev/null 2>&1 ||
  gcloud iam workload-identity-pools create "$POOL" --location global --display-name "GitLab"
gcloud iam workload-identity-pools providers describe "$PROVIDER" --workload-identity-pool "$POOL" --location global >/dev/null 2>&1 ||
  gcloud iam workload-identity-pools providers create-oidc "$PROVIDER" --workload-identity-pool "$POOL" --location global \
    --issuer-uri "https://gitlab.com" \
    --attribute-mapping "google.subject=assertion.sub,attribute.project_path=assertion.project_path,attribute.ref=assertion.ref" \
    --attribute-condition "assertion.project_path == '$GITLAB_PROJECT_PATH'"
gcloud iam service-accounts add-iam-policy-binding "$SA" --role roles/iam.workloadIdentityUser \
  --member "principalSet://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/$POOL/attribute.project_path/$GITLAB_PROJECT_PATH" >/dev/null

PROVIDER_PATH="projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/$POOL/providers/$PROVIDER"
cat <<VARS

Add these GitLab CI/CD variables (Settings > CI/CD > Variables):
  GCP_PROJECT_ID     = $GCP_PROJECT_ID
  GCP_DEPLOY_SA      = $SA
  GCP_WIF_PROVIDER   = $PROVIDER_PATH
  GCP_WIF_AUDIENCE   = https://iam.googleapis.com/$PROVIDER_PATH
VARS
