# G2A Social Hub

Agency-first multi-tenant application. Next.js App Router runs on Vercel; a separate long-running BullMQ worker runs on Railway. PostgreSQL is authoritative. Redis is a delivery mechanism, never the sole record of scheduled work. S3-compatible storage holds media, including in local development (MinIO).

## Boundaries

- `apps/web`: accessible UI, Better Auth handlers, authenticated JSON API and token-scoped external approval UI.
- `apps/worker`: durable publishing/media outbox dispatch, FFmpeg processing, retries, uncertain-delivery reconciliation, cleanup and analytics.
- `packages/core`: authorization, lifecycle rules, validation, security, provider interfaces.
- `packages/db`: versioned PostgreSQL migrations and Drizzle SQL access.
- `packages/server`: authenticated application services, storage, auth and AI.
- `scripts`: environment bootstrap, migration and fictional demo seed.

The web exposes dependency-free liveness and dependency-aware readiness routes. PostgreSQL stores worker heartbeats so health does not depend on the same Redis channel used for delivery. Owner/admin Settings aggregates tenant-scoped dead-letter, queue age, token-health and uncertain-delivery signals without exposing them publicly. The worker also claims due privacy requests and executes each organization's retention policy; PostgreSQL remains the durable source of request status and audit evidence.

Authentication uses Better Auth. Authorization is separately enforced for each organization and client. Owners/admins can access their organization's clients; other users need explicit client membership. Every resource access must prove organization and client scope server-side. Composite foreign keys prevent cross-client references even when application validation fails. External approvals use hashed, random, expiring tokens and refer to a frozen post revision.

Internal approvals carry a named assignee whose organization/client review
access is checked by both the service and a database trigger. Only that
assignee can decide the review. Reminder attempts are rate-limited and audited.
The worker materializes overdue requests as `EXPIRED`; an authenticated renewal
creates a fresh request while preserving the old request in approval history.
Approval workflows may also snapshot an automatic reminder and escalation
policy into each new request. The worker materializes due emails in a PostgreSQL
outbox, claims deliveries with row locks, retries transient SMTP failures three
times and cancels unsent delivery when its review closes or is reassigned.

## Publishing consistency

Scheduling writes a publish-job row per target in the same transaction as the post transition. A dispatcher repeatedly reconciles due durable rows into BullMQ using stable job IDs. Workers acquire row locks, recheck state and store attempts. Each target has a stable provider idempotency key. Mock and confirmed Meta delivery receipts persist in PostgreSQL. Partial success is aggregated from target states. Failed deliveries have bounded exponential retry and durable dead-letter state. Ambiguous Meta mutations stop as `META_DELIVERY_UNCERTAIN` and create a separate durable reconciliation job. That job searches recent provider content up to four times and confirms delivery only for one exact caption match inside the original attempt window. Missing or multiple matches remain unresolved for human review and are never automatically republished.

The calendar reads an authenticated, tenant-scoped date range independently
from the post library. The post library searches captions, target captions and
links in PostgreSQL; platform, status and author filters are also server-side.
It pages by the stable `(created_at,id)` order through an opaque cursor, so a
large client history is never loaded into browser memory as one result set.
Rescheduling locks publish jobs, targets and the parent post in the worker's
lock order, rejects stale revisions or any delivery evidence, then moves the
existing jobs without changing their provider idempotency keys.

UTC remains canonical for scheduled work. Each authenticated user has a
validated IANA display timezone used by the dashboard, post library, calendar,
approval state and scheduling forms. Local input is converted to UTC only after
rejecting missing or duplicated daylight-saving times. External approval pages
and system email use the organization's timezone because no signed-in user
preference is available there.

Analytics collection uses durable PostgreSQL jobs for daily account snapshots
and published-post reconciliation. The worker deduplicates work per
account/target/day, recovers interrupted claims, retries transient provider
errors three times and exposes dead work in the Operations panel. Automatic
collection fills a seven-day window, while an administrator can request a
bounded 1–90 day profile backfill. Direct Facebook and Instagram results retain
their raw Graph response and a versioned normalization mapping; secrets never
enter metric rows or logs.

Analytics reads through a separate authenticated, tenant-scoped endpoint and
accepts bounded date ranges of at most 366 days. It compares the selected
period with the immediately preceding period of equal length, sums daily
activity metrics, treats followers as the latest snapshot per provider and
ranks published content from the latest stored target metrics. Network and
provider identity remain attached to the normalized values; summed reach is
explicitly presented as non-deduplicated. Current Meta media-view metrics are
normalized into the dashboard's impressions/views fields so provider API
renames remain visible through the retained source and raw payload.

AI generation IDs are created and persisted before an external provider call.
Completion stores provider/model identity, token usage, optional estimated cost,
the exact brand-profile snapshot and the resulting guardrail report; failures
remain addressable with a safe error code. Suggestions are previews until a user
explicitly applies one. The same deterministic guardrail engine checks editor
content and blocks approval when required terminology/disclaimers are absent or
forbidden terminology/claims are present.

Personal-data exports are built from explicitly selected application tables and
exclude authentication secrets, sessions and provider credentials. Account
erasure has a 24-hour grace period, preserves organization-owned content with a
null author and blocks sole owners. Organization erasure has a 72-hour grace
period, fails closed while a live provider credential remains and deletes both
tenant rows and stored media. Privacy requests survive subject deletion as
minimal audit evidence without retaining the email address.

## Scope and honest integration boundaries

Mock mode is the locally testable baseline. The Meta direct adapter remains disabled until explicitly configured and still requires app registration, approved scopes and staging verification. LinkedIn, TikTok and Google direct operations fail explicitly. AI mock output is visibly labeled. Real AI needs an API key and explicit user invocation. No generated caption can publish automatically.

UTC timestamps are canonical; Europe/Budapest is the default personal and organization timezone. Uploads are private objects and served via short-lived signed URLs after authorization. Secrets are environment-only and credentials use AES-256-GCM with scope-bound additional authenticated data.

## Implementation roadmap

1. Foundation: monorepo, schema, auth, RBAC, encrypted credentials; verify typecheck/lint/domain and database tests.
2. Client/account and brand management; composer and per-network validation; media upload.
3. Approval snapshots, calendar and durable target publishing, retries and audit trail.
4. AI abstraction, analytics, approval automation, notifications and operations UI.
5. E2E workflow and security regression tests; deployment and platform-approval documentation.

Production launch additionally requires configured infrastructure, mail delivery, platform approvals, recovery drills, review of privacy/terms, and operational verification. A passing build alone is not a production-readiness claim.
