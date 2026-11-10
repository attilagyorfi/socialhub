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

## Integration API (v1)

`/api/v1` is the versioned API for Growth Engine and other trusted tools. Breaking changes require `/api/v2`. Requests authenticate with an organization API key created by an owner/admin in Settings: `Authorization: Bearer shk_live_…`. The key scopes every request to its organization; there is no session or cookie involved. Errors use `{ "error": { "code", "message" } }`; an invalid, missing or revoked key always returns `401` with code `INVALID_API_KEY`. Responses are `Cache-Control: no-store`.

`GET /api/v1/clients` lists the organization's non-deleted clients and their non-deleted social accounts. Remote IDs, capabilities and credentials are never included. `external_ref` is the client's external ID for matching it in Growth Engine (e.g. `mmi`, `viba-team`), or `null` when none is set. Owners/admins edit it in Clients → External ID (other roles see it read-only); it must be 1–64 lowercase letters, digits or hyphens and unique within the organization. The server rejects other values with `400 EXTERNAL_REF_INVALID`, a value already used by another client of the organization with `409 EXTERNAL_REF_TAKEN`, and other roles with `403`; an empty value clears it. Every change writes a `client.external_ref_updated` audit entry with the old and new value.

```json
{
  "data": [
    {
      "id": "uuid",
      "name": "Client",
      "external_ref": "viba-team",
      "accounts": [
        {
          "id": "uuid",
          "platform": "facebook",
          "name": "Page",
          "status": "CONNECTED"
        }
      ]
    }
  ]
}
```

`POST /api/v1/clients/{id}/drafts` uploads a batch of drafts for one client of the key's organization. It requires an `Idempotency-Key` header (8–128 characters from `A–Z a–z 0–9 . _ : -`) and a JSON body of at most 1 MB:

```json
{
  "drafts": [
    {
      "text": "Main text",
      "targets": [
        { "social_account_id": "uuid" },
        { "social_account_id": "uuid", "text": "Network-specific text" }
      ],
      "suggested_at": "2026-12-01T09:30:00+01:00",
      "media_urls": ["https://cdn.example/image.jpg"],
      "pillar": "Education",
      "source": "growth_engine"
    }
  ]
}
```

- `drafts`: 1–50 items. Unknown fields are rejected.
- `text`: required, not blank, at most 63 206 characters.
- `targets`: 1–15 items; each account at most once per draft (`422 DUPLICATE_TARGET`). A target without `text` uses the draft `text`. Every account must be a non-deleted social account of this client (otherwise `404 ACCOUNT_NOT_FOUND`) and `CONNECTED` (otherwise `422 ACCOUNT_NOT_CONNECTED`).
- `suggested_at`: optional ISO 8601 timestamp with `Z` or an offset. It is stored in `posts.suggested_at` only and never schedules the post.
- `media_urls`: optional, at most 10 HTTPS URLs without credentials. They are stored as metadata on the post; nothing is downloaded and no media asset is created.
- `pillar`, `source`: optional labels of 1–100 characters.

Every post and target is created as `DRAFT` with `scheduled_at` null, revision 1 in `post_versions` and a `post.created` audit event (actor null, `metadata.source = "api"`, `metadata.api_key_id`). No publish job or approval request is created: a person still submits, approves and schedules each draft in Social Hub. The batch is atomic: if any draft fails validation or an ownership check, nothing is written. Success is `201`:

```json
{ "data": [{ "id": "uuid", "status": "draft", "raw_status": "DRAFT" }] }
```

Errors: missing or malformed `Idempotency-Key` `400 INVALID_IDEMPOTENCY_KEY`; a body that is not JSON `400 INVALID_JSON`; a body over 1 MB `413 PAYLOAD_TOO_LARGE`; schema errors `422 VALIDATION`; a client that is not a live client of the key's organization `404 NOT_FOUND`.

Idempotency keys are scoped to the organization (shared by all its API keys) and stored in `api_idempotency_keys` with a SHA-256 hash of the client id and the canonical request body (object key order does not matter). The row is written in the same transaction as the drafts, so:

- the same key with the same client and body returns the stored status and JSON again, with `Idempotent-Replayed: true`, and creates nothing;
- the same key with a different body or client returns `422 IDEMPOTENCY_KEY_REUSED` and writes nothing;
- a concurrent retry waits on the unique `(organization_id, key)` index and then replays the committed response (`409 IDEMPOTENCY_IN_PROGRESS` if that response cannot be read yet); duplicates are never created;
- a failed request (any error status) stores nothing, so the key can be retried with a corrected body.

`GET /api/v1/posts` lists the organization's non-deleted posts of non-deleted clients, ordered by `(updated_at, id)` ascending. Optional query parameters: `client` (client UUID; another organization's or a deleted client gives `404 NOT_FOUND`), `since` (ISO 8601 timestamp with offset; posts with `updated_at >= since`), `limit` (1–200, default 50) and `cursor` (the previous page's `next_cursor`). Malformed values return `400 INVALID_QUERY` or `400 INVALID_CURSOR`. A poller can store the last `updated_at` it saw and pass it as `since`; posts with that exact timestamp are returned again rather than skipped.

```json
{
  "data": [
    {
      "id": "uuid",
      "client_id": "uuid",
      "status": "published",
      "raw_status": "PARTIALLY_PUBLISHED",
      "scheduled_at": "2026-11-02T08:00:00.000Z",
      "suggested_at": null,
      "pillar": null,
      "source": null,
      "media_urls": [],
      "created_at": "2026-11-01T10:00:00.000Z",
      "updated_at": "2026-11-02T10:00:00.000Z",
      "targets": [
        {
          "id": "uuid",
          "social_account_id": "uuid",
          "network": "facebook",
          "status": "published",
          "raw_status": "PUBLISHED",
          "published_at": "2026-11-02T09:00:00.000Z",
          "error_code": null
        }
      ]
    }
  ],
  "next_cursor": null
}
```

`status` is the contract category and `raw_status` is the exact `post_status`, always present. Posts and targets use the same mapping:

| `post_status`                                   | `status`                                                    |
| ----------------------------------------------- | ----------------------------------------------------------- |
| `DRAFT`                                         | `draft`                                                     |
| `PENDING_APPROVAL`                              | `pending_approval`                                          |
| `APPROVED`, `SCHEDULED`, `QUEUED`, `PUBLISHING` | `scheduled`                                                 |
| `PUBLISHED`, `PARTIALLY_PUBLISHED`              | `published` (check `raw_status` and targets for partials)   |
| `FAILED`                                        | `failed`                                                    |
| `CANCELLED`                                     | `cancelled` (withdrawn by a user; it will not be published) |

`cancelled` extends the five categories of the original contract; integrations should treat an unknown category as "not going to publish".

`GET /api/v1/clients/{id}/metrics?from=YYYY-MM-DD&to=YYYY-MM-DD` returns metrics already stored by the analytics sync for one live client of the key's organization. It only reads the database: it never calls a provider or queues a sync. `from` and `to` are required calendar days in UTC with `from <= to`, covering at most 92 days including both ends; a missing, malformed (not `YYYY-MM-DD`), non-existent (e.g. `2026-02-30`), reversed or longer range returns `400 INVALID_QUERY`. Another organization's, a deleted or an unknown client returns `404 NOT_FOUND` without any data.

```json
{
  "client_id": "uuid",
  "from": "2026-03-01",
  "to": "2026-03-31",
  "accounts": [
    {
      "social_account_id": "uuid",
      "provider": "facebook",
      "days": [{ "day": "2026-03-01", "metrics": { "reach": 120 } }]
    }
  ],
  "posts": [
    {
      "post_id": "uuid",
      "target_id": "uuid",
      "provider": "facebook",
      "captured_at": "2026-03-31T06:00:00.000Z",
      "metrics": { "reactions": 12 }
    }
  ]
}
```

- `accounts` holds `analytics_daily.normalized` for days `from`–`to` (inclusive), grouped by social account in ascending id order, days ascending. Accounts without stored days are omitted; stored days of an account removed later are still returned, so the history stays complete.
- `posts` holds, for each post target of a non-deleted post, the latest `post_metrics.normalized` captured in `[from 00:00 UTC, to + 1 day 00:00 UTC)`, ordered by `post_id`, then `target_id`. Earlier captures and captures outside the range are left out.
- `metrics` objects are the stored normalized metrics as they are; their keys depend on the provider. Raw provider payloads are never included.

Brand-profile endpoints and signed webhooks are planned later slices.

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
