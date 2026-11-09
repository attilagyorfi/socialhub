# Security

Implemented controls include Better Auth email/password and magic-link authentication, Redis-backed authentication throttling, separate server-side RBAC and client membership checks, validation with Zod, same-origin mutation enforcement, UUID-scoped database relations, random expiring approval tokens stored as SHA-256 hashes, and AES-256-GCM encryption for social credentials with organization/client/account authenticated context.

Access tokens and client secrets are not returned by the application API. Approval and team invitation links are bearer capabilities: share them only with the intended recipient. They expire after seven days and their raw tokens are never stored in the database. Invitation acceptance requires an authenticated account with the invited email and cannot be replayed. Successful approval decisions also cannot be replayed to change the result. Media URLs expire after five minutes.

Meta OAuth state expires after ten minutes, is stored only as SHA-256 and is consumed once before token exchange. It is bound to the initiating user, organization and client. Meta webhook POST requests are authenticated with HMAC-SHA256 over the exact raw request body before JSON parsing or persistence. Meta media delivery URLs expire after fifteen minutes because the provider must download the asset asynchronously.

Meta analytics requests send access tokens only in the Authorization header. Durable jobs and stored raw metric payloads contain provider responses, mapping identity and safe error codes, never credentials. Backfill is restricted to organization owners/administrators and bounded to 90 days per request.

Organization owners can grant administrator access. Administrators can manage lower roles but cannot grant, change or remove another administrator. Owners cannot be changed through the team screen, and users cannot remove or change their own access there. Every accepted non-admin invitation receives explicit client memberships.

`ENCRYPTION_KEY` must be 32 cryptographically random bytes encoded as 64 hex characters. `BETTER_AUTH_SECRET` must be generated independently. Secrets belong in environment settings or a secret manager. Key rotation needs a controlled re-encryption migration; changing the key alone makes existing credentials unreadable.

Production authentication requires email verification and keeps Better Auth's stricter three-attempt authentication limit. Development permits a larger ten-second burst so the serial browser regression suite can create isolated sessions without rate-limit collisions. Configure a reliable SMTP service before launch. The local Mailpit service is for development only. Google login configuration is optional and not end-to-end verified against a real Google application.

Structured application/worker logs use error codes and resource IDs. Do not add raw provider responses, request bodies, authorization headers or approval tokens to logs. Infrastructure access logs must also redact approval URLs, direct-upload signatures and OAuth query strings.

Direct uploads use random tenant-scoped incoming keys and five-minute signed PUT URLs. Completion verifies the stored size and declared type; the worker then checks file signatures and fully decodes images or uses FFprobe/FFmpeg for H.264 MP4 files. Only `READY` assets can be attached. Accepted bytes move to a different key, preventing the upload URL from replacing the publishable object. Invalid and abandoned objects are removed.

Personal-data exports use an authenticated, rate-limited endpoint with explicit table and column allowlists; passwords, sessions and social-provider credentials are excluded. Account deletion requires exact email confirmation, has a 24-hour cancellation window and is blocked for sole organization owners. Organization deletion requires owner access, exact name confirmation, a 72-hour cancellation window and prior removal of live provider grants. The worker retries failures with safe error codes, deletes tenant objects from storage and records request/retention audit events.

Organization API keys for `/api/v1` are 32 bytes from `crypto.randomBytes`, encoded as `shk_live_<base64url>`. Only their SHA-256 hash and a short prefix are stored; the raw key is returned once in the creation response and cannot be shown again. Only organization owners/administrators can create, list and revoke keys; creation and revocation write audit events containing the key name and prefix, never the key or its hash. Revoked keys stop working immediately. Missing, malformed, unknown and revoked keys all receive the same `401 INVALID_API_KEY` response, and `/api/v1` responses are `Cache-Control: no-store`. A key grants read access to its whole organization and can create drafts for any of its clients, so treat it like a password and revoke it when a tool no longer needs it. API rate limiting is not yet implemented.

Every `/api/v1` query is restricted to the key's organization. The key is verified before the request body is read; the drafts endpoint checks that the client and every target account belong to that organization and client, and identifiers of another organization or client return `404` without writing anything. Request bodies are capped at 1 MB while streaming (`413`). Drafts created through the API are always `DRAFT`, have no author, start no approval and create no publish job, so nothing is published until a person approves and schedules it in Social Hub; each draft is audited with `source = "api"` and the API key id. Media URLs must be HTTPS and are stored as text only; the server never fetches them. `Idempotency-Key` values are scoped to the organization and bound to a SHA-256 hash of the client id and canonical body. The stored response commits atomically with the drafts behind a unique index, so retries and concurrent duplicates replay the first result instead of creating posts, and a reused key with a different request is rejected.

## Outstanding production work

- Obtain Meta app review and verify OAuth, token refresh, publishing and webhook subscriptions against a real staging app.
- Review the implemented privacy workflow, legal text, processor contracts and backup-expiry policy with qualified counsel before production use.
- Security-header/CSP review, production monitoring, backup restore and failure drills.
- Live-provider validation of automatic uncertain-delivery reconciliation. Confirmed Meta responses have durable receipts; ambiguous mutations stop, use bounded read-only matching and still require human review when the match is missing or non-unique.
- Review authentication library logging, session revocation and multi-instance behavior.

The schema tests and role tests are regression checks, not a security audit or GDPR certification. Never enable live publishing based only on a passing mock workflow.
