#!/bin/zsh
set -euo pipefail

PROJECT_DIR="/Users/wenshuping/Documents/OCR_insurance"
RUNTIME_DIR="$PROJECT_DIR/.runtime"
LOCK_DIR="$RUNTIME_DIR/insurance-knowledge-daily.lock"
LOG_DIR="$RUNTIME_DIR/daily-refresh-launchd-logs"

export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export SCRAPLING_PYTHON_BIN="${SCRAPLING_PYTHON_BIN:-/Users/wenshuping/Documents/Scrapling/.venv/bin/python}"
export SCRAPLING_PROJECT_DIR="${SCRAPLING_PROJECT_DIR:-/Users/wenshuping/Documents/Scrapling}"

mkdir -p "$RUNTIME_DIR" "$LOG_DIR"

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "$(date '+%Y-%m-%d %H:%M:%S') another insurance knowledge refresh is already running"
  exit 0
fi

cleanup() {
  rmdir "$LOCK_DIR" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

STAMP="$(date '+%Y-%m-%dT%H-%M-%S%z')"
exec >> "$LOG_DIR/$STAMP.log" 2>&1

echo "=== insurance knowledge daily refresh started at $(date '+%Y-%m-%d %H:%M:%S %z') ==="
echo "project: $PROJECT_DIR"
echo "node: $(command -v node) $(node -v)"
echo "npm: $(command -v npm) $(npm -v)"
echo "python: $SCRAPLING_PYTHON_BIN"

cd "$PROJECT_DIR"

if [ -n "${DAILY_REFRESH_EXTRA_ARGS:-}" ]; then
  npm run refresh:insurance-knowledge-daily -- ${=DAILY_REFRESH_EXTRA_ARGS}
else
  npm run refresh:insurance-knowledge-daily
fi

echo "=== insurance knowledge daily refresh finished at $(date '+%Y-%m-%d %H:%M:%S %z') ==="
