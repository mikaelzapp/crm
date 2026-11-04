#!/bin/sh
set -eu
case "${1:-web}" in
  web)
    node scripts/migrate.mjs
    ./node_modules/.bin/tsx prisma/seed.ts
    exec node server.js
    ;;
  worker)
    exec ./node_modules/.bin/tsx src/worker.ts
    ;;
  *) exec "$@" ;;
esac
