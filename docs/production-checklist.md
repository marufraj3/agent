# Production deployment, backup, and recovery

## Pre-deploy checklist

- [ ] `NODE_ENV=production`; HTTPS configured for `APP_URL` and `FRONTEND_URL`.
- [ ] PostgreSQL uses TLS, automated daily backups, and a bounded connection pool in `DATABASE_URL` (for example `connection_limit=10&pool_timeout=10` per process, sized against the server maximum across API/workers).
- [ ] Redis uses authentication/TLS and AOF or managed persistence. PostgreSQL remains the source of truth; Redis queues, locks, cache, and rate counters are reconstructable.
- [ ] Unique `ADMIN_PASSWORD`, Facebook secrets, Gemini key, and Messenger credential-encryption key are supplied by the deployment secret manager, not image layers.
- [ ] Run `npm ci`, dependency audit, Prisma validation/generation, typecheck, tests, and builds.
- [ ] Verify migration SQL on a staging copy. Take and verify a backup before migration; never run `prisma db push` in production.
- [ ] Deploy API, web, incoming Messenger worker, outgoing Messenger worker, image worker, audio worker, follow-up worker, and product-sync worker.
- [ ] Verify `/health`, `/ready`, Admin System Health, all worker heartbeats, queue backlogs, product-sync freshness, Meta webhook signature/verification, mock/staging text-image-audio flows, and order API idempotency.
- [ ] Configure alerts for readiness failures, queue failed/backlog counts, Messenger auth/rate failures, AI fallback rate, order submission failures, memory/disk, and backup age.

## Backup

Run a managed PostgreSQL snapshot plus a logical backup daily. Example:

```bash
DATABASE_URL='postgresql://…' BACKUP_DIR=/secure/backups ./scripts/backup-postgres.sh
```

Encrypt backups at rest, restrict access, copy off-host, and retain according to business policy. Application logs should go to stdout and be rotated/compressed by the container platform; do not persist unbounded logs inside containers.

## Restore test

At least monthly, restore into an isolated database—not production:

```bash
RESTORE_DATABASE_URL='postgresql://…/restore_test' BACKUP_FILE=/secure/backups/alzeena-….dump ./scripts/restore-postgres.sh
```

Then run Prisma migration status and verify counts/integrity for customers, conversations, messages, products/variations, orders/items, follow-ups, settings, Messenger events/outgoing rows, and price history. Run read-only smoke tests before recording the restore test as successful.

## Migration procedure

1. Announce maintenance risk and check queue depth.
2. Take and verify a backup.
3. Deploy backward-compatible code/schema in expand-then-contract order.
4. Run `npm run db:migrate:deploy` exactly once.
5. Check `/ready`, logs, critical table/index presence, workers, and a staging/test conversation.
6. Roll back application code if needed. Restore the database only when the migration cannot safely roll forward.

## Disaster recovery

1. Stop API traffic and workers to prevent writes.
2. Provision PostgreSQL and restore the latest verified backup; apply later migrations only after verification.
3. Provision Redis. Restore managed Redis persistence if trustworthy, otherwise start clean and reconstruct scheduled jobs from PostgreSQL lifecycle rows.
4. Deploy the same immutable application image/configuration and start workers gradually.
5. Requeue database records left in safe pending/retryable states. Never blindly replay uncertain external order or Messenger sends.
6. Re-register/check the Meta webhook, run product sync, verify order API credentials, health/readiness, queue counts, alerts, and customer-facing smoke tests.

## Safe load and failure testing

Use staging, `MESSENGER_PROVIDER=mock`, mock AI/order providers, and non-customer recipients. `scripts/load-test.mjs` refuses non-local targets unless `ALLOW_STAGING_LOAD_TEST=true`. Stage 100, 500, then 1,000 requests while observing latency, errors, PostgreSQL connections, Redis memory, queue delay, CPU, memory, and disk. Never load-test real Meta customers, Gemini production quota, or the production order API.

Inject one dependency failure at a time: PostgreSQL, Redis, Gemini, Meta, product API, order API, and STT. Verify bounded timeouts, circuit breakers/retries, safe status transitions, no invented commerce facts, no duplicate orders/messages, admin alerts, and recovery after restart.
