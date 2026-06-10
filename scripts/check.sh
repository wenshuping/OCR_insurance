#!/bin/sh
set -eu

node scripts/harness-audit.mjs
npm run check
npm run typecheck
npm test
npm run build
