#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

STAMP="$(date +%Y%m%d-%H%M%S)"
ECS_PATH="${ECS_PATH:-~/OCR_insurance}"
PUBLIC_HEALTH_URL="${PUBLIC_HEALTH_URL:-https://ocr.joyhive.cn/api/health}"
LOCAL_HEALTH_URL="${LOCAL_HEALTH_URL:-http://127.0.0.1/api/health}"
SKIP_LOCAL_CHECKS=0
SKIP_PUBLIC_HEALTH=0
DRY_RUN=0

usage() {
  cat <<'USAGE'
Usage:
  ECS_HOST=<ecs-ip-or-host> [ECS_USER=root] scripts/release-family-report-hotfix-to-ecs.sh
  ECS_TARGET=root@<ecs-ip-or-host> scripts/release-family-report-hotfix-to-ecs.sh

Options:
  --skip-local-checks    Do not run local npm checks before upload.
  --skip-public-health   Skip https://ocr.joyhive.cn/api/health verification.
  --dry-run              Print what would happen without uploading or restarting ECS.
  -h, --help             Show help.

Environment:
  ECS_TARGET             Full ssh target, for example root@1.2.3.4.
  ECS_HOST               ECS hostname/IP. Used with ECS_USER when ECS_TARGET is unset.
  ECS_USER               SSH user. Default: root.
  ECS_PATH               Remote repo path. Default: ~/OCR_insurance.
  PUBLIC_HEALTH_URL      Default: https://ocr.joyhive.cn/api/health.
  LOCAL_HEALTH_URL       Default: http://127.0.0.1/api/health.

This hotfix release uploads only the current local family-report code files,
backs up the existing ECS files, rebuilds api/web images, and runs health checks.
It does not install, replace, or migrate production SQLite data.
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --skip-local-checks)
      SKIP_LOCAL_CHECKS=1
      shift
      ;;
    --skip-public-health)
      SKIP_PUBLIC_HEALTH=1
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [ -n "${ECS_TARGET:-}" ]; then
  SSH_TARGET="$ECS_TARGET"
else
  if [ -z "${ECS_HOST:-}" ] && [ "$DRY_RUN" -eq 1 ]; then
    SSH_TARGET="dry-run@ecs"
  elif [ -z "${ECS_HOST:-}" ]; then
    echo "ERROR: set ECS_HOST or ECS_TARGET" >&2
    usage >&2
    exit 1
  else
    SSH_TARGET="${ECS_USER:-root}@${ECS_HOST}"
  fi
fi

RELEASE_FILES=(
  "server/app.mjs"
  "server/routes/families.routes.mjs"
  "server/family-report-record.service.mjs"
  "server/family-policy-analysis-report.service.mjs"
  "src/api.ts"
  "src/api/contracts/family.ts"
  "src/family-report-engine.d.mts"
  "src/FamilyReport.tsx"
  "src/apps/customer/CustomerApp.tsx"
  "tests/family-policy-analysis-report.test.mjs"
)

echo "==> Release target: $SSH_TARGET:$ECS_PATH"
echo "==> Files to upload:"
printf '  %s\n' "${RELEASE_FILES[@]}"

for file in "${RELEASE_FILES[@]}"; do
  if [ ! -f "$file" ]; then
    echo "ERROR: missing local release file: $file" >&2
    exit 1
  fi
done

if [ "$SKIP_LOCAL_CHECKS" -eq 0 ]; then
  echo "==> Running local checks"
  npm run check
  node --test tests/family-policy-analysis-report.test.mjs
  npm run typecheck
  npm run build
else
  echo "==> Skipping local checks"
fi

TMP_DIR=".runtime/release-patches"
mkdir -p "$TMP_DIR"
BUNDLE="$TMP_DIR/family-report-hotfix-${STAMP}.tgz"

echo "==> Creating patch bundle: $BUNDLE"
tar -czf "$BUNDLE" "${RELEASE_FILES[@]}"

if [ "$DRY_RUN" -eq 1 ]; then
  echo "==> Dry run complete. Bundle created but not uploaded: $BUNDLE"
  exit 0
fi

REMOTE_BUNDLE="/tmp/family-report-hotfix-${STAMP}.tgz"

echo "==> Uploading bundle to ECS"
scp "$BUNDLE" "${SSH_TARGET}:${REMOTE_BUNDLE}"

echo "==> Applying bundle and rebuilding api/web on ECS"
ssh "$SSH_TARGET" \
  "ECS_PATH='$ECS_PATH' REMOTE_BUNDLE='$REMOTE_BUNDLE' STAMP='$STAMP' LOCAL_HEALTH_URL='$LOCAL_HEALTH_URL' PUBLIC_HEALTH_URL='$PUBLIC_HEALTH_URL' SKIP_PUBLIC_HEALTH='$SKIP_PUBLIC_HEALTH' sh -s" <<'REMOTE'
set -eu

case "$ECS_PATH" in
  "~") ECS_PATH="$HOME" ;;
  "~/"*) ECS_PATH="$HOME/${ECS_PATH#~/}" ;;
esac

cd "$ECS_PATH"

if [ ! -d .git ]; then
  echo "ERROR: remote path is not a git checkout: $ECS_PATH" >&2
  exit 1
fi

if [ ! -f docker-compose.poptonic.yml ]; then
  echo "ERROR: missing docker-compose.poptonic.yml on ECS" >&2
  exit 1
fi

if [ ! -f deploy/poptonic.env ]; then
  echo "ERROR: missing deploy/poptonic.env on ECS; refusing to release" >&2
  exit 1
fi

if grep -n "path:[[:space:]]*./deploy/poptonic.env" docker-compose.poptonic.yml >/dev/null 2>&1; then
  echo "ERROR: docker-compose.poptonic.yml uses unsupported Compose v2 env_file object form" >&2
  exit 1
fi

if command -v docker-compose >/dev/null 2>&1; then
  COMPOSE_KIND=legacy
elif command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  COMPOSE_KIND=plugin
else
  echo "ERROR: missing docker-compose or docker compose on ECS" >&2
  exit 1
fi

compose() {
  if [ "$COMPOSE_KIND" = legacy ]; then
    docker-compose -f docker-compose.poptonic.yml "$@"
  else
    docker compose -f docker-compose.poptonic.yml "$@"
  fi
}

echo "==> Remote current commit"
git log -1 --oneline || true

echo "==> Backing up replaced files"
mkdir -p release-backups
tar -tzf "$REMOTE_BUNDLE" | while IFS= read -r file; do
  if [ -f "$file" ]; then
    printf '%s\n' "$file"
  fi
done > "/tmp/family-report-hotfix-existing-${STAMP}.txt"

if [ -s "/tmp/family-report-hotfix-existing-${STAMP}.txt" ]; then
  tar -czf "release-backups/family-report-hotfix-before-${STAMP}.tgz" -T "/tmp/family-report-hotfix-existing-${STAMP}.txt"
  echo "Backup: $ECS_PATH/release-backups/family-report-hotfix-before-${STAMP}.tgz"
else
  echo "No existing files to back up"
fi

echo "==> Extracting hotfix files"
tar -xzf "$REMOTE_BUNDLE"

echo "==> Verifying expected hotfix markers"
grep -n "FAMILY_POLICY_ANALYSIS_RETRY_ATTEMPTS" server/family-policy-analysis-report.service.mjs
grep -n "fixed inset-x-0 top-0" src/FamilyReport.tsx
grep -n "fixed inset-x-0 top-0" src/apps/customer/CustomerApp.tsx

echo "==> Rebuilding api/web without cache"
compose stop api web || true
compose rm -f api web || true
compose build --no-cache api web

echo "==> Starting services"
compose up -d
compose ps

wait_for_url() {
  label="$1"
  url="$2"
  timeout_seconds="$3"
  started_at="$(date +%s)"
  printf 'Waiting for %s: %s\n' "$label" "$url"
  while :; do
    if command -v curl >/dev/null 2>&1; then
      if curl -fsS "$url"; then
        printf '\n%s health check passed\n' "$label"
        return 0
      fi
    elif command -v wget >/dev/null 2>&1; then
      if wget -qO- "$url"; then
        printf '\n%s health check passed\n' "$label"
        return 0
      fi
    else
      echo "ERROR: missing curl/wget on ECS" >&2
      exit 1
    fi
    now="$(date +%s)"
    if [ $((now - started_at)) -ge "$timeout_seconds" ]; then
      printf '\n' >&2
      compose logs --tail=120 api >&2 || true
      echo "ERROR: $label health check timed out: $url" >&2
      exit 1
    fi
    printf '.'
    sleep 2
  done
}

echo "==> Waiting for api container health"
started_at="$(date +%s)"
while :; do
  if compose exec -T api sh -lc 'wget -qO- http://127.0.0.1:4206/api/health >/dev/null' >/dev/null 2>&1; then
    echo "api container health check passed"
    break
  fi
  now="$(date +%s)"
  if [ $((now - started_at)) -ge 120 ]; then
    compose logs --tail=120 api >&2 || true
    echo "ERROR: api container health timed out" >&2
    exit 1
  fi
  printf '.'
  sleep 2
done

wait_for_url "local" "$LOCAL_HEALTH_URL" 90

if [ "$SKIP_PUBLIC_HEALTH" -eq 0 ]; then
  wait_for_url "public" "$PUBLIC_HEALTH_URL" 120
else
  echo "==> Skipping public health check"
fi

echo "==> Verifying production DB path"
if compose logs --tail=160 api 2>/dev/null | grep "db=/data/policy-ocr.sqlite" >/dev/null 2>&1; then
  echo "API log confirms db=/data/policy-ocr.sqlite"
else
  echo "WARNING: recent API logs did not include db=/data/policy-ocr.sqlite" >&2
fi

echo "==> Verifying AI config without printing secrets"
compose exec -T api node --input-type=module <<'NODE'
import { isFamilySalesReviewConfigured } from './server/family-sales-review.service.mjs';
console.log(JSON.stringify({
  deepseekApiKeyConfigured: Boolean(process.env.DEEPSEEK_API_KEY),
  familySalesReviewConfigured: isFamilySalesReviewConfigured(),
  familyPolicyAnalysisModel: 'deepseek-v4-pro',
  familyPolicyAnalysisRetryAttempts: process.env.FAMILY_POLICY_ANALYSIS_RETRY_ATTEMPTS || '3',
}, null, 2));
NODE

rm -f "$REMOTE_BUNDLE" "/tmp/family-report-hotfix-existing-${STAMP}.txt"

echo "==> ECS hotfix release complete"
REMOTE

echo "==> Done"
