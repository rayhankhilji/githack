#!/usr/bin/env bash
# Cloud Run release steps (configure + release stages). Usage: deploy.sh staging|canary|promote|rollback
set -euo pipefail
SERVICE="${CLOUD_RUN_SERVICE:-tallybook}"
REGION="${GCP_REGION:-us-central1}"
IMAGE="${GCP_REGION:-us-central1}-docker.pkg.dev/${GCP_PROJECT_ID}/${AR_REPOSITORY:-tallybook}/tallybook:${CI_COMMIT_SHA}"
TAG="rc-${CI_COMMIT_SHORT_SHA}"
run() { gcloud run "$@" --region "$REGION" --quiet; }

case "$1" in
  staging)
    # Remember what is serving now so rollback has a target.
    PREVIOUS=$(gcloud run services describe "$SERVICE" --region "$REGION" \
      --format='value(status.traffic[0].revisionName)' 2>/dev/null || true)
    # Deploy the new revision with 0% traffic. Its tag URL is the staging environment.
    run deploy "$SERVICE" --image "$IMAGE" --no-traffic --tag "$TAG" \
      --allow-unauthenticated --cpu 1 --memory 256Mi --min-instances 0 --max-instances 3 \
      --set-env-vars "FLAG_NEW_TOTALS=on,FLAG_LEGACY_PDF=off,FLAG_HOLIDAY_BANNER_2024=off" \
      --update-secrets "TALLYBOOK_API_KEY=tallybook-api-key:latest"
    REVISION=$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.latestCreatedRevisionName)')
    URL=$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')
    TAG_URL=$(gcloud run services describe "$SERVICE" --region "$REGION" \
      --format="value(status.traffic.filter(tag:$TAG).url)" 2>/dev/null || true)
    [[ -z "$TAG_URL" ]] && TAG_URL="https://${TAG}---${URL#https://}"
    {
      echo "REVISION=$REVISION"
      echo "PREVIOUS_REVISION=${PREVIOUS:-$REVISION}"
      echo "STAGING_URL=$TAG_URL"
      echo "CANARY_URL=$TAG_URL"
      echo "PRODUCTION_URL=$URL"
    } > deploy.env
    cat deploy.env
    curl -fsS "$TAG_URL/healthz"
    ;;
  canary)
    run services update-traffic "$SERVICE" --to-revisions "${REVISION}=${CANARY_PERCENT:-10}"
    ;;
  promote)
    run services update-traffic "$SERVICE" --to-revisions "${REVISION}=100"
    ;;
  rollback)
    run services update-traffic "$SERVICE" --to-revisions "${PREVIOUS_REVISION}=100"
    echo "Rolled back to $PREVIOUS_REVISION"
    ;;
  *)
    echo "usage: deploy.sh staging|canary|promote|rollback" >&2
    exit 2
    ;;
esac
