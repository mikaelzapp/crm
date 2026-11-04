#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
backup_dir="${1:-./private/backups}"
umask 077
mkdir -p "$backup_dir"
backup_file="$backup_dir/crm-$(date -u +%Y%m%dT%H%M%SZ).dump"
partial_file="$backup_file.partial"
trap 'rm -f "$partial_file"' EXIT HUP INT TERM
# POSTGRES_PASSWORD já está no ambiente do contêiner. Não aparece na linha de comando.
docker compose exec -T postgres sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --format=custom' > "$partial_file"
[ -s "$partial_file" ]
mv "$partial_file" "$backup_file"
printf 'Backup salvo em %s\n' "$backup_file"
