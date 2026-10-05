# G2A Social Hub

An agency workspace for client brands, mock social accounts, content creation, external approvals and server-side publishing. This repository is an actively developed MVP, not a production launch release. Live social API integration and several operational features are still incomplete; see `ROADMAP.md`.

## Local setup

Requirements: Node.js 22.17 or newer, npm, Docker with a Linux engine, and Google Chrome for browser tests.

```sh
npm ci
node scripts/init-env.mjs
docker compose up -d
npm run db:migrate
npm run db:seed
npm run dev
```

Start the worker in a second terminal:

```sh
npm run worker
```

For video processing, run the FFmpeg-equipped worker container instead:

```sh
docker compose --profile worker up -d --build worker
```

For a configured public Meta staging environment, run the fail-closed live verification after connecting an account and publishing a recent test post:

```sh
npm run meta:verify
```

Open http://localhost:3010. Use `DEMO_EMAIL` and the randomly generated `DEMO_PASSWORD` from `.env`. The seed never prints the password. You can also create your own account from the login page. Do not use these development services or credentials in production.

If Docker Desktop's selected context is unavailable on Windows but the default engine is running, use `docker --context default compose up -d`.

`init-env.mjs` creates `.env` for scripts/worker and `apps/web/.env.local` for Next.js. It refuses to overwrite existing files. Keep both copies aligned after changing environment values. Neither file belongs in Git.

Local services:

| Service          | Address               |
| ---------------- | --------------------- |
| Application      | http://localhost:3010 |
| PostgreSQL       | localhost:55432       |
| Redis            | localhost:6379        |
| MinIO S3         | http://localhost:9000 |
| MinIO console    | http://localhost:9001 |
| Test email inbox | http://localhost:8025 |

The seed is non-destructive: if the demo user already has an organization it skips creation. Demo clients, captions and analytics are fictional. Previously scheduled demo posts become due as real time passes.

## Working flow

1. Sign in and choose or create a client.
2. Owners and administrators can invite teammates from Team, choose their role and limit access to specific clients. Local invitation messages appear in Mailpit; a development copy link is also shown after creation.
3. Invitees create an account or sign in through the expiring invitation link. Membership starts only after acceptance.
4. Connect mock accounts in Connected accounts. A configured and approved Meta app also enables the Facebook & Instagram OAuth button; local setup leaves it disabled.
5. Save brand knowledge and enforceable terminology, claim and disclaimer rules in Clients.
6. Upload an image or H.264 MP4 in Media. The browser sends it directly to private storage and shows it as ready after background validation.
7. Select profiles, write a base caption, request a writing suggestion if desired, review its brand score, then explicitly apply it. Recent generations remain available with provider/model, usage, outcome and application metadata. Attach media and customize network captions or attachments.
8. Save a draft. Open its details and send it for approval. Blocking brand-rule violations must be corrected first. Internal workflows require a named reviewer with access to that client.
9. Complete the configured review steps. The default is external review; Clients also supports internal review or internal followed by client review. Workflow settings can schedule internal-review reminders and escalate overdue internal or client reviews to organization administrators. Deliveries use a durable, retrying outbox and appear in Settings → Operations. Social managers can also reassign an active internal review or send a rate-limited reminder manually. Expired requests are recorded and can be renewed for seven days. Open the generated external link to review captions/attachments and approve or request changes. Returned drafts can be edited and resubmitted; old revision links become invalid.
10. Choose a personal IANA display timezone in Settings. Use Posts to search captions or links and filter the full client history by status, network or author. Results use stable cursor pagination. Open an approved post and schedule it in your display timezone or choose Publish now. A scheduled post that has not started publishing can be dragged to another calendar day while retaining its local time, or moved to an exact time from its details. Ambiguous and missing daylight-saving times, stale screens and jobs with delivery attempts are rejected.
11. The separately running worker publishes each target. If a Meta mutation loses its response, a durable reconciliation job safely searches recent provider content and confirms only one exact caption/time-window match; it never blindly republishes. Administrators can recheck unresolved deliveries from Settings → Operations. Calendar loads its visible date range independently and filters by network, status or author. Analytics provides 7/30/90-day and custom ranges, period comparison, network breakdown and top-content ranking from durable daily synchronization jobs. The worker automatically fills the latest seven days after an outage; administrators can queue a 30-day analytics reconciliation from Settings → Operations. Settings also shows the audit log.
12. Privacy settings provide a rate-limited JSON export, a 24-hour cancellable account-deletion request, a 72-hour cancellable organization-deletion request for owners, and a configurable 30–3650 day retention period. Organization deletion requires live provider grants to be disconnected first. The worker performs due erasures and daily retention cleanup.

Mock captions containing `[mock:fail]` demonstrate permanent rejection. `[mock:rate-limit]` fails twice and succeeds on the third attempt. These markers have meaning only in mock mode.

Post details also allow rotating a pending external review link and cancelling an unpublished scheduled post. Cancellation prevents remaining queued deliveries; posts with an already published target cannot be cancelled through this action.

## Verification

```sh
npm run typecheck
npm run lint
npm test
npm run build
npm run test:e2e
```

The browser tests require the web server, worker, local services and seeded demo user. They create and clean up uniquely named local test users, organizations and clients. Unit/schema tests use an isolated embedded PostgreSQL-compatible PGlite database. No real social publishing or paid API calls are required.

Meta unit tests use an injected HTTP transport. Enabling real Meta access additionally requires the settings and app-review steps in `SOCIAL_PROVIDERS.md` and `DEPLOYMENT.md`; localhost media URLs are intentionally rejected.

The FFmpeg video test is opt-in and requires the containerized worker:

```powershell
$env:MEDIA_E2E="1"
npx.cmd playwright test tests/e2e/media.spec.ts
```

## Documentation

- `ARCHITECTURE.md`: boundaries and reliability model
- `DATABASE.md`: schema and migrations
- `SOCIAL_PROVIDERS.md`: mock/direct integration boundaries
- `SECURITY.md`: implemented controls and launch gaps
- `DEPLOYMENT.md`: Vercel/Railway configuration
- `OPERATIONS.md`: health checks, alerts, incident response and restore drills
- `API_APPROVALS.md`: administrator integration checklist
- `ROADMAP.md`: completed and outstanding scope
