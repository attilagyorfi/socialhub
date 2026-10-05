# Implementation status

## Implemented baseline

- Next.js/TypeScript monorepo and PostgreSQL schema/migrations.
- Better Auth password and magic-link configuration; server-side organization/client authorization.
- Client creation, mock account connection/disconnection and encrypted credentials.
- Brand profile, draft creation/editing, version snapshots, network captions/media overrides and capability warnings.
- Browser-direct private S3-compatible uploads, durable processing jobs, full image decoding, H.264 MP4 metadata/posters, client media library and signed previews.
- Configurable internal, external or internal-to-client review, expiring/rotatable external links, decisions/comments and revision invalidation.
- Named internal reviewer assignment, reassignment, rate-limited email reminders,
  durable expiry, seven-day renewal and per-post approval history.
- Workflow-level automatic internal reminders and overdue-review escalation,
  backed by a retrying/cancellable email outbox and Operations visibility.
- Change-request resubmission and cancellation of unpublished scheduled posts.
- UTC scheduling, per-target durable jobs, BullMQ worker, mock deduplication and retries.
- Personal IANA timezone settings across calendar, scheduling, post and audit
  timestamps, with UTC persistence and daylight-saving gap/overlap rejection.
- Independent date-range calendar views with server-side platform/status/author
  filters and safe revision-checked form/drag-and-drop rescheduling; server-side
  post search/filtering with stable cursor pagination; basic mock charts,
  notifications and audit display.
- Independent Analytics API with bounded custom and 7/30/90-day ranges,
  equal-period KPI comparison, daily trends, network breakdown and top-content
  ranking from the latest stored post metrics.
- Durable AI generation history with preallocated IDs, provider/model and token/cost metadata, brand-profile snapshots, explicit apply actions and addressable records.
- Brand guardrails for required/forbidden terminology, prohibited claims, required disclaimers and platform length limits, with composer feedback and approval blocking.
- Durable attempt records, interrupted-attempt tracking and recovery of completed Redis jobs when database work remains pending.
- Owner/admin team management, expiring email invitations, role and client assignment, access revocation and audit events.
- Fail-closed Meta OAuth, encrypted Page/Instagram credentials, scheduled token refresh, signed webhook ingestion, Facebook/Instagram single-media publishing, durable provider receipts and bounded uncertain-delivery reconciliation.
- Liveness/readiness endpoints, persistent worker heartbeat, container healthcheck and owner/admin operations summary for queue, token and uncertain-delivery signals.
- Authenticated personal-data export; cancellable 24-hour account and 72-hour organization erasure; provider-revocation guard; object cleanup; daily configurable retention; and durable privacy audit evidence.
- Durable daily analytics jobs, seven-day automatic catch-up, administrator-triggered reconciliation, Operations visibility and current Facebook/Instagram metric normalization with retained raw source data.
- Fail-closed Meta staging verifier for public configuration, granted scopes, connected identity, provider content, receipt-backed publication and live profile/post insights.
- Fictional seed, domain/schema regression tests and browser workflow tests.

## Verification — 2026-09-30

- TypeScript typecheck and ESLint: passed.
- Optimized Next.js production build: passed.
- Unit/schema tests: 63 passed, including all eighteen migrations, timezone and daylight-saving semantics, privacy evidence preservation, approval-delivery and AI-generation tenant constraints, brand-rule semantics, analytics range/aggregation and current Meta metric normalization semantics, exact-window Meta publication matching, fail-closed public staging preflight, post-list cursor/query validation, reviewer-scope constraints, readiness policy, service heartbeats, safe calendar rescheduling, Meta OAuth/webhook/publishing behavior, provider/reconciliation evidence tenant constraints, media-job tenant constraints and cross-organization invitation constraints.
- Standard browser tests: 19 passed and the opt-in FFmpeg case was skipped in the standard run, against the local web server, healthy worker container, PostgreSQL, Redis, MinIO and Mailpit. The opt-in FFmpeg media test passed in its latest dedicated run.
- Covered flows: safe liveness/readiness output; login and password change; personal timezone persistence, validation and audit; personal export without secrets; cancellable account and organization erasure with sole-owner protection; worker execution and bounded retention; team invitation, scoped access, acceptance and revocation; browser-direct image upload → processing → persisted mock AI preview/apply → draft → review → background publishing; brand-rule explanation and approval blocking; automatic approval reminder delivery, SMTP retry scheduling, reassignment cancellation and administrator escalation; independent calendar range loading and idempotency-preserving rescheduling; server-side post search/filtering and multi-page cursor traversal; Analytics period comparison, network filtering, top-content ranking, durable backfill, deduplication and Operations visibility; exact-match uncertain Meta delivery reconciliation with durable receipt, target/post recovery, audit and administrator recheck; secret-safe Meta staging preflight and Graph permission transport; valid H.264 MP4 metadata/poster extraction; invalid-video rejection and object cleanup; tenant isolation/viewer restrictions/CSRF; retry and partial failure; assigned internal-to-external approvals, email reminder cooldown, expiry/renewal, link rotation, revision invalidation and scheduled cancellation; desktop/mobile navigation, admin Operations and dialog Escape handling.
- Desktop and 390px mobile screenshots inspected for the workspace and the Settings/Operations layout.
- This verifies the local mock workflow. Real social APIs and production hosting remain unverified.

## Outstanding requested scope

### Delivery priority

1. **Completed locally:** team administration, invitations, role/client assignment, access revocation and audit coverage.
2. **Completed locally:** production media pipeline, direct private uploads, video metadata/posters, FFmpeg processing and abandoned-upload cleanup.
3. **Implemented locally:** Meta OAuth, token refresh, webhook verification, Facebook/Instagram single-media publishing, durable receipts, explicit uncertain-delivery handling, bounded read-only reconciliation and an automated staging verifier. Real app credentials, app approval and execution against a public staging account remain open.
4. **Operational foundation implemented locally:** health probes, worker heartbeat/healthcheck, admin queue/token visibility and documented backup/restore/rollback runbook. Hosted staging, alert wiring and a recorded restore drill remain open.
5. **In progress:** product depth. Independent calendar range loading, safe
   form/drag-and-drop rescheduling, full post-library queries, the stored
   metrics Analytics dashboard, AI generation governance/brand guardrails and
   personal timezone handling, privacy workflows and provider metric mappings
   are implemented locally; live Meta analytics still requires approved scopes
   and staging verification.

- Meta app review/staging verification, live reconciliation validation, additional provider adapters and optional Ayrshare adapter.
- Live-provider AI prompt evaluation, model-specific cost configuration and production usage monitoring.
- Verify live Meta analytics mappings, rate limits and historical availability against an approved staging application.
- Legal/privacy review, processor inventory and production backup-expiry verification.
- Production deployment verification, monitoring and failure/recovery tests.

Mock functionality must remain clearly labeled. Incomplete live paths must continue to fail closed.
