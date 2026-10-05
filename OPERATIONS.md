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

Owners and administrators can see these job, approval-email, token and worker signals under Settings → Operations. Do not expose the tenant-scoped detail to unauthenticated monitoring.

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

Enable managed PostgreSQL point-in-time recovery and encrypted daily backups with a retention period approved by the data-retention policy. The following commands illustrate a portable logical backup; supply credentials through the platform secret mechanism rather than command history:

```sh
pg_dump --format=custom --no-owner --no-acl --file=g2a-social-hub.dump "$DATABASE_URL"
pg_restore --list g2a-social-hub.dump
```

Run quarterly restore drills into a new, isolated database:

1. Create an empty temporary database with no route from production web/worker services.
2. Restore with `pg_restore --no-owner --no-acl --dbname="$RESTORE_DATABASE_URL" g2a-social-hub.dump`.
3. Point a temporary release at the restored database and separate Redis/S3 test resources.
4. Run migrations, authentication smoke checks, tenant-isolation tests and one complete mock publishing workflow.
5. Record backup timestamp, restore duration, row-count checks, migration version and operator. Destroy the temporary environment according to retention policy.

Never test a restore by replacing the production database. A schema migration needs a forward fix unless a separately reviewed rollback migration exists.

## Redis and object storage

Redis is not authoritative. If Redis is lost, preserve PostgreSQL, start an empty Redis with `noeviction`, restart the worker and confirm that due database jobs are dispatched again using stable IDs.

Enable object versioning or provider-native recovery where available, server-side encryption, access logging and lifecycle rules for abandoned `incoming/` objects. Test recovery using a copied test object and verify that tenant-scoped signed access still works. Database restore and object restore must target a consistent recovery window.

An organization owner must disconnect and revoke every live provider grant before requesting organization deletion. Align database backups, object versions and provider-native recovery windows with the published retention policy. The online worker removes current database rows and objects, but cannot shorten an immutable backup provider's expiry window.

## Rollout and rollback

Apply migrations once before dependent application code. Deploy the worker and web with the same `APP_REVISION`, verify readiness, sign-in, admin Operations, one upload and one mock delivery, then increase traffic. Keep the previous application image available. Rolling back code is allowed only while it remains compatible with the applied schema; otherwise ship a forward fix.
