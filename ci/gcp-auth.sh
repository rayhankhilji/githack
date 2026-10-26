#!/usr/bin/env bash
# Authenticates gcloud in CI. Preferred: keyless Workload Identity Federation with a GitLab OIDC id_token.
# Fallback: a base64 service-account key in the masked variable GCP_SA_KEY.
set -euo pipefail
if [[ -n "${GCP_SA_KEY:-}" ]]; then
  echo "$GCP_SA_KEY" | base64 -d > "$CI_BUILDS_DIR/.gcp-key.json"
  gcloud auth activate-service-account --key-file="$CI_BUILDS_DIR/.gcp-key.json" --quiet
else
  : "${GCP_ID_TOKEN:?GCP_ID_TOKEN missing: set id_tokens on the job}"
  : "${GCP_WIF_PROVIDER:?set GCP_WIF_PROVIDER (projects/N/locations/global/workloadIdentityPools/P/providers/R)}"
  echo "$GCP_ID_TOKEN" > "$CI_BUILDS_DIR/.gitlab-oidc.jwt"
  gcloud iam workload-identity-pools create-cred-config "$GCP_WIF_PROVIDER" \
    --service-account="$GCP_DEPLOY_SA" \
    --credential-source-file="$CI_BUILDS_DIR/.gitlab-oidc.jwt" \
    --output-file="$CI_BUILDS_DIR/.gcp-cred.json"
  gcloud auth login --cred-file="$CI_BUILDS_DIR/.gcp-cred.json" --quiet
fi
gcloud config set project "$GCP_PROJECT_ID" --quiet
