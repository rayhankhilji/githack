#!/usr/bin/env bash
# Pushes this repository to your GitLab hackathon project (the judged repo must be on GitLab).
# Usage: GITLAB_REPO_URL=https://gitlab.com/<group>/<subgroup>/<project>.git scripts/push-to-gitlab.sh
set -euo pipefail
: "${GITLAB_REPO_URL:?set GITLAB_REPO_URL}"
git remote get-url gitlab >/dev/null 2>&1 || git remote add gitlab "$GITLAB_REPO_URL"
git push gitlab HEAD:main
echo "Pushed to $GITLAB_REPO_URL (main)"
