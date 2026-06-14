#!/bin/sh
set -eu

RELEASE_REF=""
SKIP_FETCH=0
SKIP_NPM_CI=0
LOG_FILE="/root/autodl-tmp/ocr-service.log"
HEALTH_URL=""

usage() {
  cat <<'USAGE'
Usage: scripts/release-autodl-ocr.sh [options]

Run on the AutoDL host from the OCR_insurance repository root.

Options:
  --ref <git-ref>           Git ref to deploy. Default: current upstream, then origin/master.
  --skip-fetch              Do not run git fetch origin.
  --skip-npm-ci             Do not run npm ci --omit=dev.
  --log-file <path>         Default: /root/autodl-tmp/ocr-service.log
  --health-url <url>        Default after env load: http://127.0.0.1:${OCR_SERVICE_PORT}/internal/ocr-service/health
  -h, --help                Show this help.

This script restarts only the AutoDL OCR service. It does not touch ECS or SQLite data.
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
    --skip-npm-ci)
      SKIP_NPM_CI=1
      shift
      ;;
    --log-file)
      [ "$#" -ge 2 ] || die "--log-file requires a value"
      LOG_FILE="$2"
      shift 2
      ;;
    --health-url)
      [ "$#" -ge 2 ] || die "--health-url requires a value"
      HEALTH_URL="$2"
      shift 2
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
require_command node
require_command npm

[ -d .git ] || die "Run this from the OCR_insurance repository root"
[ -f deploy/autodl-ocr.env ] || die "Missing deploy/autodl-ocr.env on this AutoDL host"
[ -f ocr-service/index.mjs ] || die "Missing ocr-service/index.mjs"

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

if [ "$SKIP_NPM_CI" -eq 0 ]; then
  info "Installing production Node dependencies"
  npm ci --omit=dev
else
  info "Skipping npm ci"
fi

info "Loading AutoDL environment"
set -a
. deploy/autodl-ocr.env
set +a

if [ -z "$HEALTH_URL" ]; then
  OCR_SERVICE_PORT_VALUE="${OCR_SERVICE_PORT:-6006}"
  HEALTH_URL="http://127.0.0.1:${OCR_SERVICE_PORT_VALUE}/internal/ocr-service/health"
fi

LOG_DIR="$(dirname "$LOG_FILE")"
mkdir -p "$LOG_DIR"

info "Stopping old OCR service"
pkill -f "node ocr-service/index.mjs" >/dev/null 2>&1 || true

info "Starting OCR service"
nohup node ocr-service/index.mjs > "$LOG_FILE" 2>&1 &
SERVICE_PID="$!"
echo "Started OCR service pid=$SERVICE_PID log=$LOG_FILE"

sleep 2
if ! kill -0 "$SERVICE_PID" >/dev/null 2>&1; then
  tail -n 80 "$LOG_FILE" >&2 || true
  die "OCR service exited immediately"
fi

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
  url="$1"
  timeout_seconds="$2"
  started_at="$(date +%s)"

  printf 'Waiting for OCR health: %s\n' "$url"
  while :; do
    if fetch_url "$url"; then
      printf '\nOCR health check passed\n'
      return 0
    fi

    if ! kill -0 "$SERVICE_PID" >/dev/null 2>&1; then
      tail -n 80 "$LOG_FILE" >&2 || true
      die "OCR service exited before health check passed"
    fi

    now="$(date +%s)"
    if [ $((now - started_at)) -ge "$timeout_seconds" ]; then
      printf '\n' >&2
      tail -n 80 "$LOG_FILE" >&2 || true
      die "OCR health check timed out after ${timeout_seconds}s"
    fi

    printf '.'
    sleep 2
  done
}

info "Recent OCR log"
tail -n 40 "$LOG_FILE" || true

info "Checking OCR health"
wait_for_url "$HEALTH_URL" 90

info "OCR release completed"
echo "AutoDL OCR service is running from $RELEASE_REF."
