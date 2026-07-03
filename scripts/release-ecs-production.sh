#!/bin/sh
set -eu

COMPOSE_FILE="docker-compose.poptonic.yml"
LOCAL_HEALTH_URL="http://127.0.0.1/api/health"
PUBLIC_HEALTH_URL="https://ocr.joyhive.cn/api/health"
RELEASE_REF=""
SKIP_FETCH=0
SKIP_BUILD=0
SKIP_LOCAL_HEALTH=0
SKIP_PUBLIC_HEALTH=0
ALLOW_PAY_NOT_READY=0

usage() {
  cat <<'USAGE'
Usage: scripts/release-ecs-production.sh [options]

Run on the ECS host from the OCR_insurance repository root.

Options:
  --ref <git-ref>              Git ref to deploy. Default: current upstream, then origin/master.
  --skip-fetch                 Do not run git fetch origin.
  --skip-build                 Restart existing images without rebuilding.
  --skip-local-health          Skip host-local health check.
  --skip-public-health         Skip public health check.
  --local-health-url <url>     Default: http://127.0.0.1/api/health
  --public-health-url <url>    Default: https://ocr.joyhive.cn/api/health
  --allow-pay-not-ready        Do not fail if admin or WeChat Pay config is incomplete.
  -h, --help                   Show this help.

This script releases code only. It never installs or overwrites production SQLite data.
USAGE
}

die() {
  echo "ERROR: $*" >&2
  exit 1
}

info() {
  printf '\n==> %s\n' "$*"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "Missing command: $1"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --ref)
      [ "$#" -ge 2 ] || die "--ref requires a value"
      RELEASE_REF="$2"
      shift 2
      ;;
    --skip-fetch)
      SKIP_FETCH=1
      shift
      ;;
    --skip-build)
      SKIP_BUILD=1
      shift
      ;;
    --skip-local-health)
      SKIP_LOCAL_HEALTH=1
      shift
      ;;
    --skip-public-health)
      SKIP_PUBLIC_HEALTH=1
      shift
      ;;
    --local-health-url)
      [ "$#" -ge 2 ] || die "--local-health-url requires a value"
      LOCAL_HEALTH_URL="$2"
      shift 2
      ;;
    --public-health-url)
      [ "$#" -ge 2 ] || die "--public-health-url requires a value"
      PUBLIC_HEALTH_URL="$2"
      shift 2
      ;;
    --allow-pay-not-ready)
      ALLOW_PAY_NOT_READY=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "Unknown option: $1"
      ;;
  esac
done

require_command git
require_command grep

[ -d .git ] || die "Run this from the OCR_insurance repository root"
[ -f "$COMPOSE_FILE" ] || die "Missing $COMPOSE_FILE"
[ -f deploy/poptonic.env ] || die "Missing deploy/poptonic.env on this ECS host"

if grep -n "path:[[:space:]]*./deploy/poptonic.env" "$COMPOSE_FILE" >/dev/null 2>&1; then
  die "$COMPOSE_FILE uses Compose v2 env_file object form; ECS needs legacy list form"
fi

grep -n "./deploy/poptonic.env" "$COMPOSE_FILE" >/dev/null 2>&1 \
  || die "$COMPOSE_FILE does not reference ./deploy/poptonic.env"

if command -v docker-compose >/dev/null 2>&1; then
  COMPOSE_KIND="legacy"
elif command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  COMPOSE_KIND="plugin"
else
  die "Missing docker-compose or docker compose"
fi

compose() {
  if [ "$COMPOSE_KIND" = "legacy" ]; then
    docker-compose -f "$COMPOSE_FILE" "$@"
  else
    docker compose -f "$COMPOSE_FILE" "$@"
  fi
}

if [ -z "$RELEASE_REF" ]; then
  RELEASE_REF="$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)"
  [ -n "$RELEASE_REF" ] || RELEASE_REF="origin/master"
fi

info "Release target: $RELEASE_REF"

if [ "$SKIP_FETCH" -eq 0 ]; then
  info "Fetching origin"
  git fetch origin
fi

info "Resetting repository to $RELEASE_REF"
git reset --hard "$RELEASE_REF"

info "Current commit"
git log -1 --oneline

info "Docker compose command"
if [ "$COMPOSE_KIND" = "legacy" ]; then
  docker-compose --version
else
  docker compose version
fi

info "Stopping api/web"
compose stop api web || true
compose rm -f api web || true

if [ "$SKIP_BUILD" -eq 0 ]; then
  info "Building api/web without cache"
  compose build --no-cache api web
else
  info "Skipping image build"
fi

info "Starting services"
compose up -d

info "Compose status"
compose ps

fetch_url() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsS "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO- "$1"
  else
    return 127
  fi
}

wait_for_url() {
  label="$1"
  url="$2"
  timeout_seconds="$3"
  started_at="$(date +%s)"

  printf 'Waiting for %s: %s\n' "$label" "$url"
  while :; do
    if fetch_url "$url"; then
      printf '\n%s health check passed\n' "$label"
      return 0
    fi

    now="$(date +%s)"
    if [ $((now - started_at)) -ge "$timeout_seconds" ]; then
      printf '\n' >&2
      die "$label health check timed out after ${timeout_seconds}s: $url"
    fi

    printf '.'
    sleep 2
  done
}

wait_for_container_api() {
  timeout_seconds="$1"
  started_at="$(date +%s)"
  printf 'Waiting for api container health'

  while :; do
    if compose exec -T api sh -lc 'wget -qO- http://127.0.0.1:4206/api/health >/dev/null' >/dev/null 2>&1; then
      printf '\napi container health check passed\n'
      return 0
    fi

    now="$(date +%s)"
    if [ $((now - started_at)) -ge "$timeout_seconds" ]; then
      printf '\n' >&2
      compose logs --tail=80 api >&2 || true
      die "api container health check timed out after ${timeout_seconds}s"
    fi

    printf '.'
    sleep 2
  done
}

info "Waiting for container API health"
wait_for_container_api 90

if [ "$SKIP_LOCAL_HEALTH" -eq 0 ]; then
  info "Checking host-local health"
  wait_for_url "local" "$LOCAL_HEALTH_URL" 60
else
  info "Skipping host-local health check"
fi

if [ "$SKIP_PUBLIC_HEALTH" -eq 0 ]; then
  info "Checking public health"
  wait_for_url "public" "$PUBLIC_HEALTH_URL" 90
else
  info "Skipping public health check"
fi

info "Verifying persistent SQLite path"
if compose logs --tail=120 api 2>/dev/null | grep "db=/data/policy-ocr.sqlite" >/dev/null 2>&1; then
  echo "API log confirms db=/data/policy-ocr.sqlite"
else
  echo "WARNING: recent API logs did not include db=/data/policy-ocr.sqlite" >&2
fi

check_production_config() {
  compose exec -T api node --input-type=module <<'NODE'
import { isFamilySalesReviewConfigured } from './server/family-sales-review.service.mjs';
import { resolveWechatPayConfig } from './server/wechat-pay.service.mjs';

const adminPasswordConfigured = Boolean(process.env.POLICY_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD);
const deepseekApiKeyConfigured = Boolean(process.env.DEEPSEEK_API_KEY);
let pay = null;
let payConfigError = null;
try {
  pay = resolveWechatPayConfig();
} catch (error) {
  payConfigError = {
    message: error?.message || String(error),
    code: error?.code || '',
    path: error?.path || '',
  };
  pay = {
    mode: process.env.WECHAT_PAY_MODE || 'disabled',
    nodeEnv: process.env.NODE_ENV || '',
    ready: false,
    notifyUrl: process.env.WECHAT_PAY_NOTIFY_URL || '',
  };
}
const summary = {
  adminPasswordConfigured,
  ai: {
    deepseekApiKeyConfigured,
    familySalesReviewConfigured: isFamilySalesReviewConfigured(),
    model: process.env.DEEPSEEK_FAMILY_REVIEW_MODEL || process.env.DEEPSEEK_MODEL || 'deepseek-v4-pro',
  },
  wechatPay: {
    mode: pay.mode,
    ready: pay.ready,
    appId: Boolean(pay.appId),
    mchId: Boolean(pay.mchId),
    apiV3Key: Boolean(pay.apiV3Key),
    serialNo: Boolean(pay.serialNo),
    privateKey: Boolean(pay.privateKey),
    platformPublicKey: Boolean(pay.platformPublicKey),
    platformPublicKeyId: Boolean(pay.platformPublicKeyId),
    notifyUrl: pay.notifyUrl,
    configError: payConfigError,
  },
};
console.log(JSON.stringify(summary, null, 2));

if (!adminPasswordConfigured) {
  console.error('ADMIN_PASSWORD_NOT_CONFIGURED');
  process.exitCode = 2;
} else if (!deepseekApiKeyConfigured) {
  console.error('DEEPSEEK_API_KEY_NOT_CONFIGURED');
  process.exitCode = 5;
} else if (payConfigError) {
  console.error('WECHAT_PAY_CONFIG_ERROR');
  process.exitCode = 4;
} else if (pay.nodeEnv === 'production' && pay.mode !== 'live') {
  console.error('WECHAT_PAY_MODE_NOT_LIVE');
  process.exitCode = 3;
} else if (pay.nodeEnv === 'production' && !pay.ready) {
  console.error('WECHAT_PAY_NOT_CONFIGURED');
  process.exitCode = 4;
}
NODE
}

info "Checking admin, AI, and WeChat Pay readiness"
if check_production_config; then
  echo "Production config check passed"
else
  config_status=$?
  if [ "$ALLOW_PAY_NOT_READY" -eq 1 ] && { [ "$config_status" -eq 3 ] || [ "$config_status" -eq 4 ]; }; then
    echo "WARNING: production config is incomplete, continuing because --allow-pay-not-ready was set" >&2
  else
    die "Production config check failed. Fix deploy/poptonic.env or rerun with --allow-pay-not-ready."
  fi
fi

info "Release completed"
echo "Code is deployed. SQLite data was not changed by this script."
