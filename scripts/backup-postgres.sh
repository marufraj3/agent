#!/bin/sh
set -eu
: "${DATABASE_URL:?DATABASE_URL is required}"
BACKUP_DIR=${BACKUP_DIR:-./backups}
mkdir -p "$BACKUP_DIR"
umask 077
file="$BACKUP_DIR/alzeena-$(date -u +%Y%m%dT%H%M%SZ).dump"
pg_dump --format=custom --no-owner --no-acl --dbname="$DATABASE_URL" --file="$file"
pg_restore --list "$file" >/dev/null
printf '%s\n' "$file"
