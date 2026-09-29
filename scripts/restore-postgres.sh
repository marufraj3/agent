#!/bin/sh
set -eu
: "${RESTORE_DATABASE_URL:?RESTORE_DATABASE_URL is required and must point to an isolated restore-test database}"
: "${BACKUP_FILE:?BACKUP_FILE is required}"
[ "${CONFIRM_RESTORE_TEST:-}" = "RESTORE_TO_ISOLATED_DATABASE" ] || { echo 'Set CONFIRM_RESTORE_TEST=RESTORE_TO_ISOLATED_DATABASE' >&2; exit 2; }
pg_restore --clean --if-exists --no-owner --no-acl --exit-on-error --dbname="$RESTORE_DATABASE_URL" "$BACKUP_FILE"
psql "$RESTORE_DATABASE_URL" -v ON_ERROR_STOP=1 -c 'SELECT COUNT(*) AS products FROM products; SELECT COUNT(*) AS orders FROM orders; SELECT COUNT(*) AS messages FROM messages;'
