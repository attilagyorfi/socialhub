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

## Outstanding production work

- Obtain Meta app review and verify OAuth, token refresh, publishing and webhook subscriptions against a real staging app.
- Review the implemented privacy workflow, legal text, processor contracts and backup-expiry policy with qualified counsel before production use.
- Security-header/CSP review, production monitoring, backup restore and failure drills.
- Live-provider validation of automatic uncertain-delivery reconciliation. Confirmed Meta responses have durable receipts; ambiguous mutations stop, use bounded read-only matching and still require human review when the match is missing or non-unique.
- Review authentication library logging, session revocation and multi-instance behavior.

The schema tests and role tests are regression checks, not a security audit or GDPR certification. Never enable live publishing based only on a passing mock workflow.
