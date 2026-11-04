#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
restore_file="${1:?Uso: scripts/restore.sh caminho.dump --confirmar-substituicao}"
[ "${2:-}" = '--confirmar-substituicao' ] || { echo 'A restauracao substitui os dados. Informe --confirmar-substituicao.' >&2; exit 1; }
[ -s "$restore_file" ] || { echo 'Backup ausente ou vazio.' >&2; exit 1; }
# Pare escritores. Erros mantêm web/worker parados para inspeção, em vez de publicar dados incompletos.
docker compose stop worker web
docker compose exec -T postgres sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" pg_restore --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --clean --if-exists --no-owner --no-privileges --exit-on-error' < "$restore_file"
docker compose up -d web worker
