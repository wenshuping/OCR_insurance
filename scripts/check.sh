#!/bin/sh
set -eu

npm run check
npm run typecheck
npm test
npm run build
