#!/bin/sh
set -eu

case "${1:-start}" in
  start)
    npm run local:dev
    ;;
  stop)
    npm run local:dev:stop
    ;;
  status)
    npm run local:status
    ;;
  *)
    echo "Usage: ./scripts/dev.sh [start|stop|status]" >&2
    exit 2
    ;;
esac
