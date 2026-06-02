#!/bin/sh
set -eu

if [ "$#" -eq 0 ]; then
  npm test
else
  node --test "$@"
fi
