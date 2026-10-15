# Operations runbook

This runbook defines the minimum staging and production checks for G2A Social Hub. Replace provider-specific examples with the actual managed-service procedures before launch and record the owner of every alert.

## Health and release identity

- `GET /api/health/live` proves that the web process can answer HTTP. It performs no dependency calls and returns `200` while the process is alive.
- `GET /api/health/ready` checks PostgreSQL, Redis, the S3 bucket and the latest worker heartbeat. It returns `503` when a required dependency is unavailable and never returns connection strings, host names or raw errors.
- Set `APP_REVISION` to the deployed Git SHA or release identifier on both web and worker services. It appears in safe health metadata and the admin Operations panel.
- Production requires a worker by default. `HEALTH_REQUIRE_WORKER=false` is intended for local web-only development. `HEALTH_REQUIRE_STORAGE=false` should be used only for a deliberate maintenance window.
- The worker writes a heartbeat every ten seconds. A heartbeat older than thirty seconds is stale. Its container image also has a database-backed healthcheck.
- The worker checks due erasure requests and organization retention policies every minute. Erasure requests retry up to three times with a safe `error_code`; retention is attempted at most once per organization every 24 hours.

Recommended alerts:

| Signal                    | Alert condition        |
| ------------------------- | ---------------------- |
| Web readiness             | non-200 for 2 minutes  |
| Worker heartbeat          | stale for 60 seconds   |
| Oldest due job            | over 5 minutes         |
| Publish/media dead-letter | any new row            |
| Approval email delivery   | three failed attempts  |
| Analytics reconciliation  | any dead sync job      |
| `META_DELIVERY_UNCERTAIN` | immediate human review |
| Delivery reconciliation   | any unresolved job     |
| Unhealthy social token    | any connected account  |

The worker emails and reports these signals automatically, except web readiness and the worker heartbeat, which need an external uptime monitor (see Alerting). Owners and administrators can see these job, approval-email, token and worker signals under Settings → Operations. Do not expose the tenant-scoped detail to unauthenticated monitoring.

## Alerting

The worker runs `runAlertChecks()` (`packages/server/alerts.ts`) every five
minutes across all organizations. It raises an alert for:

| Kind                        | Trigger                                                    |
| --------------------------- | ---------------------------------------------------------- |
| `publish_uncertain`         | publish job `DEAD` with `META_DELIVERY_UNCERTAIN`          |
| `reconciliation_unresolved` | delivery reconciliation job `UNRESOLVED`                   |
| `publish_dead`              | any other `DEAD` publish job                               |
| `media_dead`                | `DEAD` media-processing job                                |
| `queue_stuck`               | oldest due publish/media job waiting over 5 minutes        |
| `analytics_dead`            | `DEAD` analytics sync job                                  |
| `approval_email_failed`     | approval email failed three times                          |
| `token_unhealthy`           | connected social account with unhealthy token              |

Each distinct problem (kind + job/account ID, stored in `operational_alerts`)
notifies once. When it disappears it is marked resolved; if it comes back later
it notifies again. All new problems of one run are sent in one Hungarian email
to `ALERT_EMAIL` (organization/client names and IDs only, no post content or
tokens) and reported to Sentry as a warning per kind (fingerprint
`operational-alert` + kind). Without `ALERT_EMAIL` the email is skipped with an
`operational_alert_email_skipped` log line and only Sentry is notified. A failed
email is logged (`operational_alert_email_failed`) and retried on the next run.

The worker cannot report its own absence, and the web app does not send
alerts. A stale worker heartbeat makes `/api/health/ready` return 503, so an
external uptime monitor covers it (operator task): for example an UptimeRobot
HTTP(S) monitor on `https://hub.g2amarketing.hu/api/health/ready` every 5
minutes, expecting status 200 (or keyword `"status":"ok"`), alerting the
operator after 2 consecutive failures.

## Error monitoring

With `SENTRY_DSN` (server, worker) and `NEXT_PUBLIC_SENTRY_DSN` (browser,
inlined at build time) set, unexpected errors are reported to Sentry. Reports
are scrubbed of tokens, cookies, request bodies, email and IP addresses. To
confirm delivery, an owner or administrator can POST
`{"action":"operations.sentry-test","clientId":"<client>"}` to `/api/hub`; the
call returns 503 and a "Sentry test error" issue appears in Sentry.

## Incident triage

1. Check `/api/health/ready` to identify the failed dependency and compare the web and worker `APP_REVISION` values.
2. Check structured web/worker logs using the event and safe error code. Never paste authorization headers, OAuth callback URLs, signed object URLs or raw webhook bodies into an incident channel.
3. For a stale worker, restart one worker instance and confirm a fresh heartbeat before scaling. Durable PostgreSQL jobs are the source of truth; Redis jobs are rebuilt by the dispatcher.
4. For `DEAD` jobs, inspect `publish_attempts` or `media_processing_jobs.last_error`. Correct the underlying configuration/content before creating a new attempt.
5. For `META_DELIVERY_UNCERTAIN`, allow the worker's four bounded reconciliation checks to finish. A single exact provider match is converted into a durable receipt and published target automatically. For `UNRESOLVED`, use Settings → Operations to recheck after correcting token/API issues, then inspect the Facebook Page or Instagram account. Never blindly requeue because the provider may already have published the post.
6. For a failed approval email, verify SMTP configuration and recipient validity. The outbox retries three times with backoff; do not manually recreate a delivery row.
7. After recovery, verify that the oldest due age decreases, no duplicate remote post appeared, and the parent post status matches all targets.
8. For `privacy_erasure_failed`, inspect only the request type and safe error code. Restore provider revocation or storage access, then leave the durable failed request for its scheduled retry. Do not delete a privacy request to hide a failure.
9. For a dead analytics job, inspect its safe error code and the account token-health state. Reconnect expired grants or correct app permissions, then use Settings → Operations to queue a bounded 30-day reconciliation. The request reuses existing account/target/day jobs and is safe to repeat.

## PostgreSQL backup and restore drill

### Automatic daily backups (worker)

With `BACKUP_ENABLED=true` the worker runs `pg_dump --format=custom` once a day
and uploads the file to object storage under `backups/postgres/` (bucket
`BACKUP_BUCKET`, defaulting to `S3_BUCKET`). Backups older than
`BACKUP_RETENTION_DAYS` (default 14) are deleted; the newest is always kept.
Each successful run logs a `database_backup` event with the key and size. The
worker image installs the PostgreSQL 18 client, matching the hosted server.

`scripts/backup-now.ts` (`npm run backup:now`) takes one extra backup
immediately, ignoring `BACKUP_ENABLED` and the daily schedule, and prunes old
backups the same way. Use it before a risky migration, or before a restore
drill when the newest backup is older than the data you want to verify. On
Railway, run it from the temporary drill service (step 2 below) with the start
command `./node_modules/.bin/tsx scripts/backup-now.ts`, then switch the start
command back to the drill. The first automatic backup is taken right after
the worker first starts, which can be before migrations have run.

### Restore drill (Railway)

`scripts/restore-drill.ts` (`npm run restore:drill`) restores the newest
`backups/postgres/*.dump` object into an empty temporary database and verifies
it. It runs from the worker image, which already contains the script and the
PostgreSQL 18 client (`pg_restore`). It refuses to run when
`RESTORE_DATABASE_URL` is missing, points to the same host, port and database as
`DATABASE_URL`, or the target already has tables in the `public` schema. It
never prints connection strings.

The drill checks that `schema_migrations` is not empty (migrations in the
repository but missing from the backup are reported as "newer than backup",
not as a failure), reports row counts for the key tables and runs integrity
queries (every client has an organization, every post a client, every target a
post, every member a user). It prints one JSON line (`"event":"restore_drill"`
with backup key, timestamp, size, restore seconds, migrations, row counts and
checks) followed by a human summary, and exits with 1 on any failure.

Run it at least quarterly and after any change to the backup set-up:

1. In the Railway production project add a temporary **PostgreSQL** service
   (for example `postgres-drill`). Do not enable public networking.
2. Add a temporary service from the same GitHub repository and the
   `production` branch (for example `restore-drill`; to test an unreleased
   change of the drill itself, use its feature branch):
   - Settings → Build: Dockerfile path `Dockerfile.worker`.
   - Settings → Deploy: custom start command
     `./node_modules/.bin/tsx scripts/restore-drill.ts`, restart policy
     **Never**, no healthcheck path, no public domain.
   - Variables: the worker's variables (at least `DATABASE_URL`,
     `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`
     and `BACKUP_BUCKET` if set) plus
     `RESTORE_DATABASE_URL=${{postgres-drill.DATABASE_URL}}`. Use the reference
     syntax with the temporary service's real name; never paste a production
     connection string. `DATABASE_URL` is only used for the same-database guard.
     Do not set `BACKUP_ENABLED` or `ALERT_EMAIL` on this service.
3. Deploy once and read the `restore_drill` JSON line and the summary in the
   deploy logs. `Restore drill: PASSED` and exit code 0 mean success.
4. Record the result in the "Restore drill log" table below.
5. Delete both temporary services (the restored database contains production
   data).

For a deeper drill, point a temporary release at the restored database with
separate Redis/S3 test resources and run sign-in, tenant-isolation and one mock
publishing workflow before deleting it.

#### Restore drill log

| Date | Operator | Backup key / timestamp | Size | Restore (s) | Migrations | Key row counts | Result |
| ---- | -------- | ---------------------- | ---- | ----------- | ---------- | -------------- | ------ |
|      |          |                        |      |             |            |                |        |

### Manual backup

Enable managed PostgreSQL point-in-time recovery and encrypted daily backups with a retention period approved by the data-retention policy. The following commands illustrate a portable logical backup and restore; supply credentials through the platform secret mechanism rather than command history:

```sh
pg_dump --format=custom --no-owner --no-acl --file=g2a-social-hub.dump "$DATABASE_URL"
pg_restore --list g2a-social-hub.dump
pg_restore --no-owner --no-acl --exit-on-error --dbname="$RESTORE_DATABASE_URL" g2a-social-hub.dump
```

Never test a restore by replacing the production database. A schema migration needs a forward fix unless a separately reviewed rollback migration exists.

## Redis and object storage

Redis is not authoritative. If Redis is lost, preserve PostgreSQL, start an empty Redis with `noeviction`, restart the worker and confirm that due database jobs are dispatched again using stable IDs.

Enable object versioning or provider-native recovery where available, server-side encryption, access logging and lifecycle rules for abandoned `incoming/` objects. Test recovery using a copied test object and verify that tenant-scoped signed access still works. Database restore and object restore must target a consistent recovery window.

An organization owner must disconnect and revoke every live provider grant before requesting organization deletion. Align database backups, object versions and provider-native recovery windows with the published retention policy. The online worker removes current database rows and objects, but cannot shorten an immutable backup provider's expiry window.

## Rollout and rollback

Apply migrations once before dependent application code. Deploy the worker and web with the same `APP_REVISION`, verify readiness, sign-in, admin Operations, one upload and one mock delivery, then increase traffic. Keep the previous application image available. Rolling back code is allowed only while it remains compatible with the applied schema; otherwise ship a forward fix.
