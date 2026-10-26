#!/usr/bin/env bash
# Cloud Run release steps (configure + release stages). Usage: deploy.sh staging|canary|promote|rollback
# Needs gcloud, curl and python3 (all present in google/cloud-sdk:slim).
set -euo pipefail
SERVICE="${CLOUD_RUN_SERVICE:-tallybook}"
REGION="${GCP_REGION:-us-central1}"
IMAGE="${REGION}-docker.pkg.dev/${GCP_PROJECT_ID}/${AR_REPOSITORY:-tallybook}/tallybook:${CI_COMMIT_SHA}"
TAG="rc-${CI_COMMIT_SHORT_SHA}"
run() { gcloud run "$@" --region "$REGION" --quiet; }

# Prints one field of `gcloud run services describe --format=json`. gcloud projections cannot
# filter a list by a sibling field, so the traffic block is parsed with python3.
#   serving        revision with the largest traffic share (the one production serves now)
#   tag-url TAG    URL of the traffic target carrying TAG
describe() {
  gcloud run services describe "$SERVICE" --region "$REGION" --format=json 2>/dev/null |
    python3 -c '
import json, sys
svc = json.load(sys.stdin)
traffic = svc.get("status", {}).get("traffic", [])
what = sys.argv[1]
if what == "serving":
    live = [t for t in traffic if t.get("percent") and t.get("revisionName")]
    if live:
        print(max(live, key=lambda t: t["percent"])["revisionName"])
elif what == "tag-url":
    print(next((t.get("url", "") for t in traffic if t.get("tag") == sys.argv[2]), ""))
' "$@" || true
}

case "$1" in
  staging)
    # Remember what is serving now so rollback has a target.
    PREVIOUS=$(describe serving)
    # Deploy the new revision with 0% traffic. Its tag URL is the staging environment.
    # gcloud rejects --no-traffic when the service does not exist yet, so the very first deploy takes all traffic.
    NO_TRAFFIC=(--no-traffic)
    [[ -z "$PREVIOUS" ]] && NO_TRAFFIC=()
    run deploy "$SERVICE" --image "$IMAGE" "${NO_TRAFFIC[@]}" --tag "$TAG" \
      --allow-unauthenticated --cpu 1 --memory 256Mi --min-instances 0 --max-instances 3 \
      --set-env-vars "FLAG_NEW_TOTALS=on,FLAG_LEGACY_PDF=off,FLAG_HOLIDAY_BANNER_2024=off" \
      --update-secrets "TALLYBOOK_API_KEY=tallybook-api-key:latest"
    REVISION=$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.latestCreatedRevisionName)')
    URL=$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')
    TAG_URL=$(describe tag-url "$TAG")
    # Documented tag URL shape: https://TAG---SERVICE-HASH-REGION.a.run.app (only valid for *.run.app URLs).
    [[ -z "$TAG_URL" ]] && TAG_URL="https://${TAG}---${URL#https://}"
    {
      echo "REVISION=$REVISION"
      echo "PREVIOUS_REVISION=${PREVIOUS:-$REVISION}"
      echo "STAGING_URL=$TAG_URL"
      echo "CANARY_URL=$TAG_URL"
      echo "PRODUCTION_URL=$URL"
    } > deploy.env
    cat deploy.env
    # A fresh revision may need a moment before its tag route answers.
    for i in 1 2 3 4 5 6; do curl -fsS "$TAG_URL/healthz" && exit 0; sleep 5; done
    exit 1
    ;;
  canary)
    # Name both sides explicitly. With only REV=10, gcloud scales every other serving revision
    # proportionally to fill the remaining 90%, which is wrong if an earlier split is still live.
    if [[ "$REVISION" == "$PREVIOUS_REVISION" ]]; then
      echo "First deploy: $REVISION already serves 100%; nothing to split."
    else
      run services update-traffic "$SERVICE" \
        --to-revisions "${REVISION}=${CANARY_PERCENT:-10},${PREVIOUS_REVISION}=$((100 - ${CANARY_PERCENT:-10}))"
    fi
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
