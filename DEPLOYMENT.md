# Deployment

Target: Next.js on Vercel, long-running BullMQ worker on Railway, managed PostgreSQL and Redis, private S3/R2. Nothing has been deployed to a public domain by this repository setup.

## Web

Use the repository's locked dependencies. Vercel project root is the repository; build with `npm run build`. Configure the Next.js application directory `apps/web` according to the platform's monorepo settings. Validate output and server tracing before production rollout. Do not deploy a static export: authentication and API routes require a server runtime.

Set `APP_URL` to the actual HTTPS origin, such as the intended `https://app.g2amarketing.hu`; no domain is hardcoded into application logic. Configure matching Better Auth and provider redirects. Use a pooled PostgreSQL endpoint sized for serverless concurrency. Use TLS for production database/Redis connections and a private network for the worker when available.

## Worker

Run `npm run worker:prod` as a separate long-lived service with the same database, Redis, provider mode, encryption key and `APP_REVISION`. The supplied `Dockerfile.worker` installs FFmpeg/FFprobe and includes a database-backed healthcheck; `docker compose --profile worker up -d --build worker` exercises the same runtime locally. Do not host this polling worker as a short-lived Vercel request. Provision an always-on worker, restart policy, structured log collection, resource limits and alerts on stale heartbeat, durable `DEAD` publishing/media jobs and uncertain Meta delivery.

Apply migrations once per release before rolling out dependent code. Seed only local mock environments. Keep Redis persistence enabled and use `noeviction`; PostgreSQL durable job records are the recovery source. Test recovery from loss of Redis before launch.

Configure the web platform to probe `/api/health/live` for liveness and `/api/health/ready` for readiness. Production readiness requires PostgreSQL, Redis, storage and a worker heartbeat unless explicitly changed with a documented maintenance setting. Set `APP_REVISION` to the same immutable release identifier on web and worker. See `OPERATIONS.md` for alert thresholds, incident handling and backup/restore drills.

## Storage and mail

Use a private S3/R2 bucket. Set bucket CORS to allow `PUT`, `GET` and `HEAD` only from the actual `APP_URL` origin. `S3_ENDPOINT` is the worker/server endpoint; set `S3_PUBLIC_ENDPOINT` when that hostname is not browser-reachable. Keep `S3_MANAGE_BUCKET=false` in production and provision the bucket/CORS through infrastructure tooling so application credentials do not need bucket-administration rights. The browser receives a five-minute signed URL for a random incoming key and sends bytes directly to storage, avoiding Vercel request body limits. Accepted files are copied to a separate ready key so the upload URL cannot overwrite the publishable object. Signed download URLs are generated only after client authorization.

Configure a lifecycle rule that removes unreferenced `incoming/` objects after a short safety window. The worker marks database uploads abandoned after one hour, but a storage lifecycle also covers failures before the database record is created.

Use real SMTP delivery and a verified sender. Do not copy local MinIO/PostgreSQL credentials into hosted services.

## Meta

Create and approve a Meta Business app before enabling live connections. Configure its valid OAuth redirect as `${APP_URL}/api/oauth/meta/callback` and its webhook callback as `${APP_URL}/api/webhooks/meta`. Set the same random `META_WEBHOOK_VERIFY_TOKEN` in Meta and the application. Request and obtain production access for `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `read_insights`, `instagram_basic`, `instagram_content_publish` and `instagram_manage_insights`; development-role access alone is not a production approval.

Set `META_INTEGRATION_ENABLED=true`, `META_APP_ID`, `META_APP_SECRET` and an explicitly reviewed `META_GRAPH_VERSION` (v26.0 is current as of 2026-10). For a business-type app, also set `META_LOGIN_CONFIG_ID` to a Facebook Login for Business configuration that grants the permissions above; the login dialog then uses `config_id` instead of `scope`. Upgrade the pinned version only after staging OAuth, Page discovery, image/video publishing, token refresh and webhook tests. `S3_PUBLIC_ENDPOINT` must be HTTPS and publicly downloadable by Meta for the lifetime of the signed media URL. Keep the bucket private; the application supplies a short-lived signed object URL.

After connecting the staging Page or Instagram professional account through the application, set `META_STAGING_ACCOUNT_ID` to its local UUID. Publish one uniquely identifiable test post through the normal approval and worker flow, wait for its provider receipt, then run `npm run meta:verify`. The verifier prints only safe check names, account/platform identity and normalized metric field names. It fails unless OAuth identity, every required permission, recent provider content, profile insights, a receipt-backed publication from the last seven days and that post's insights are all readable. It never prints tokens or raw provider payloads.

Meta enforces HTTPS redirect URIs, including for development apps. To test OAuth locally, register `https://localhost:3010/api/oauth/meta/callback` in the app's Facebook Login for Business settings, create a self-signed certificate (never install a local CA into the system trust store), set `APP_URL=https://localhost:3010` in both env files and run `npm run dev:https`:

```sh
mkdir -p .local/certs
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 825 -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" -keyout .local/certs/localhost-key.pem -out .local/certs/localhost.pem
```

The browser shows a certificate warning once per session. In development mode only people with an app role can grant the requested permissions.

The local stack intentionally leaves Meta disabled and cannot complete media publishing through `localhost`. `npm run meta:verify` therefore fails during preflight until public staging settings are supplied. Automated tests use an injected Graph transport and make no Meta calls. Before production, verify app review, data-use checkup, privacy-policy/data-deletion URLs, webhook field subscriptions and the runbook for `META_DELIVERY_UNCERTAIN` jobs.

## Launch gate

The full mock workflow and the opt-in FFmpeg media test must pass in the target staging environment. Meta app approval, real staging verification, provider-specific media restrictions, privacy processes, backup restore, monitoring, alert ownership and rollout/rollback procedures remain explicit release requirements. See `ROADMAP.md`; this repository is not yet production-ready.
