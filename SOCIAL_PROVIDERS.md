# Social providers

`SocialProvider` is the domain boundary. It includes connection, revocation, refresh, capabilities, validation, publishing, deletion, status, metrics, comments and webhook methods. Domain services do not invoke platform HTTP APIs directly.

## Mock

`SOCIAL_PROVIDER_MODE=mock` is the functional baseline. Connected accounts explicitly show mock mode. Delivery waits briefly, validates capabilities, simulates rejection and rate limits, and records persistent receipts. Retrying an identical idempotency key returns the original mock remote ID. No social API receives these posts.

Metrics are synthetic and labeled `mock:<platform>`. Mock comment retrieval returns an empty collection. Disconnect revokes the local mock credential. Mock publishing and analytics run server-side without a browser.

## Direct

Meta is the first implemented direct adapter. It is fail-closed unless `META_INTEGRATION_ENABLED=true` and `META_APP_ID`, `META_APP_SECRET` and a pinned `META_GRAPH_VERSION` are all set. OAuth uses a ten-minute, one-use state bound to the signed-in administrator and client. Business-type apps send a Facebook Login for Business `config_id` (`META_LOGIN_CONFIG_ID`) instead of the scope list. The callback exchanges the code for a long-lived user token, retrieves manageable Facebook Pages and their linked Instagram professional accounts, and stores per-account credentials with AES-GCM tenant/account binding. The worker attempts refresh within seven days of expiry and marks failed or expired credentials in account health.

The Meta adapter publishes Facebook text/link posts, a single image, a single MP4 or a multi-photo post, plus Instagram single images, carousels and Reels. Instagram media uses the container/status/publish sequence. Private objects are exposed to Meta through a fifteen-minute signed GET URL, one per attachment; `S3_PUBLIC_ENDPOINT` must therefore be reachable by Meta and cannot be localhost.

### Carousels and multi-photo posts

Limits live in one place, `mediaSetErrors` in `packages/core/domain.ts` (called from `validatePost`), and are applied when a draft is saved or edited, when it is submitted or scheduled, by the worker and again inside `publishMeta` before any Graph call:

| Network | Several attachments |
| --- | --- |
| Instagram | carousel of 2–10 images |
| Facebook | multi-photo post of 2–10 images |
| LinkedIn, Google Business, TikTok | not supported: one image or video per post |

Mixing images and videos in one post is not supported on any network, and the same attachment cannot appear twice in a target. `mediaSetErrors` returns stable codes (`MEDIA_ERRORS`: `media.duplicate`, `media.too_many`, `media.images_only`, `media.single`). Server responses (`MEDIA_UNSUPPORTED`, `DUPLICATE_MEDIA` or `VALIDATION`) carry the English text from `MEDIA_ERROR_TEXT`; the composer translates the codes through `composer.validation.*`, and the image limit in both texts comes from `MULTI_IMAGE_LIMIT`. Attachments are never dropped silently. One image or one video keeps the single-media route (Instagram image or Reel, Facebook photo or video).

The order is `post_targets.media_ids`. Every read by `id=ANY(...)` is reordered with `inMediaOrder`, so the worker, validation and the approval pages (per post and monthly bundle) use and show the attachments in that order. The composer numbers the selected attachments and lets the user reorder them with up/down buttons.

- **Instagram carousel:** for each image, in order, `POST /{ig-user}/media` with `image_url` and `is_carousel_item=true`, then the container status is polled (`status_code`) until `FINISHED`. Then `POST /{ig-user}/media` with `media_type=CAROUSEL`, `children` (the item container IDs in order) and the caption, a status check of that parent, and finally `POST /{ig-user}/media_publish`. The ID returned by `media_publish` is the receipt and `post_targets.remote_id`.
- **Facebook multi-photo post:** for each image, in order, `POST /{page}/photos` with `url` and `published=false`, then a single `POST /{page}/feed` with the caption and `attached_media[i]={"media_fbid":…}` in the same order. The feed post ID (`{page}_{post}`) is the receipt and `post_targets.remote_id`.

**Partial failures.** Only `media_publish` and the `/feed` call publish anything, so only those are delivery calls. If an item container cannot be created, ends in `ERROR`/`EXPIRED`, or a photo upload is refused, the sequence stops before the parent container or the feed post and the target fails with `META_MEDIA_REJECTED` (not retried). A rate limit or Meta outage on those preparatory calls keeps its retryable code (`META_RATE_LIMIT`, `META_UNAVAILABLE`, `META_MEDIA_PROCESSING`); the retry starts again with new containers or photos. Unpublished Instagram containers are never visible on the profile and expire on Meta's side; `published=false` Page photos are not shown on the Page or in the feed. Neither is stored as a remote ID. A lost or 5xx response on `media_publish` or `/feed` is `META_DELIVERY_UNCERTAIN` like any other Meta delivery: no automatic resend, and reconciliation looks for the final post by caption (Instagram lists carousels as `CAROUSEL_ALBUM`, which is not filtered out). The publish job's idempotency key and `provider_receipts` guarantee that a repeated job never calls `media_publish` or `/feed` again once a receipt exists.

The Meta adapter also reads daily Facebook Page and Instagram professional-account insights plus published-post metrics. The current mapping uses Meta's post-June-2026 media-view metrics (`page_media_view`, `page_total_media_view_unique`, `post_media_view` and `post_total_media_view_unique`) and Instagram `views`, `reach` and interaction totals. Raw responses are retained next to normalized dashboard values. Collection is durable, retries transient failures, automatically fills the latest seven days and supports a bounded administrator-triggered backfill. Production use requires approved `read_insights` and `instagram_manage_insights` permissions in addition to the publishing scopes.

Meta delivery responses are persisted in `provider_receipts` under the publish job's idempotency key before the outer job transaction completes. Confirmed rate limits and transient pre-response errors follow the worker retry policy. A connection loss during a mutating Graph call is classified as `META_DELIVERY_UNCERTAIN` and is not automatically republished, because Meta may already have accepted the post. A durable worker job reads the Page's published posts or Instagram professional account media, retries bounded lookup failures and confirms only one exact caption match inside a five-minute margin around the original attempt. Zero or multiple matches remain `UNRESOLVED` for human review. Owners and administrators can request another check from Operations.

`/api/webhooks/meta` implements Meta's verification challenge and validates `X-Hub-Signature-256` against the unmodified request body. Valid mapped events are deduplicated and stored under the matching tenant/account. Configure `META_WEBHOOK_VERIFY_TOKEN` in both the application and Meta dashboard. Event-specific webhook processing remains future work; publication reconciliation currently uses provider reads.

Disconnecting one Page/Instagram card revokes the associated Meta user grant, then removes every local Facebook/Instagram credential in that client that shares the grant. This avoids presenting a local-only disconnect as provider revocation.

`npm run meta:verify` is the staging launch check. It validates the public HTTPS configuration, connected identity, actual granted scopes, publication listing, profile insights, a recent receipt-backed post created through this application and that post's insights. The report omits credentials and raw provider payloads. A local mock environment is expected to fail its preflight.

### First comment

Each target can carry an optional first comment (`post_targets.first_comment`, at most 2200 characters, the Instagram comment limit). It is part of the post input and therefore of the `post_versions` snapshot: both approval pages (per post and monthly bundle) show it per account, and changing it after approval works like changing the caption (back to draft, new revision, new approval).

| Network | First comment |
| --- | --- |
| Facebook Page post | supported: `POST /{page-post-id}/comments` |
| Instagram | supported: `POST /{ig-media-id}/comments` |
| LinkedIn, Google Business, TikTok | not available; the composer says so in place of the field and the server rejects a non-blank text with `FIRST_COMMENT_UNSUPPORTED` (422) |

- **Only after a confirmed publication.** `enqueueFirstComment` runs in the transaction that marks the target `PUBLISHED` (direct delivery or reconciliation of an uncertain delivery). An uncertain post gets no comment job until reconciliation confirms it.
- **Durable and idempotent.** One `first_comment_jobs` row per target (`UNIQUE(target_id)`); its idempotency key is `md5(target_id || ':first_comment')::uuid`, so a duplicate enqueue is a no-op. The comment ID is stored in `provider_receipts` (provider `meta:facebook:comment` / `meta:instagram:comment`); a job that finds a receipt never calls Graph again. The worker processes due jobs every 5 seconds (`processFirstComments`).
- **Retries.** Rate limits (`META_RATE_LIMIT`) and 5xx answers (`META_UNAVAILABLE`) are retried with exponential backoff, at most 5 attempts.
- **Uncertain delivery.** A lost response (timeout or dropped connection after sending) or a success without an ID is `META_DELIVERY_UNCERTAIN`: the job becomes `UNCERTAIN` and is never resent automatically. A job left `RUNNING` by a dead worker for 15 minutes also becomes `UNCERTAIN`. Check the post and add the comment by hand if needed.
- **Failures stay on the comment.** A final error (`FAILED`, e.g. `META_REJECTED`) or an uncertain comment never changes the target or post status; the post view shows the comment status and error, and a notification is created.
- **Mock accounts** only write a local receipt (`mock:{platform}:comment`); nothing leaves the process.

Production use needs `pages_manage_engagement` (Facebook) and `instagram_manage_comments` (Instagram) approved in Meta App Review. The OAuth flow already requests both; the App Review submission is handled by the owner (see APP_REVIEW.md).

### Hashtag sets

Each client has named hashtag sets (`client_hashtag_sets`), managed in the client settings by users with `manage` permission on that client (`hashtags.save` / `hashtags.delete` on `/api/hub`). Hashtags are stored as `#tag` without whitespace, duplicates removed, at most 30 per set; names are unique per client (case-insensitive). The composer inserts a chosen set with one click into the caption or a target's first comment.

## LinkedIn (personal profile)

`packages/server/linkedin.ts` connects one LinkedIn member profile per OAuth grant and publishes text or text plus a single image as that member. It stays fail-closed: unless `LINKEDIN_INTEGRATION_ENABLED=true`, `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`, `LINKEDIN_REDIRECT_URI` (must end in `/api/oauth/linkedin/callback`, HTTPS outside localhost) and a `YYYYMM` `LINKEDIN_API_VERSION` are all set, every entry point returns `PROVIDER_NOT_CONFIGURED`, no OAuth state is written, no request leaves the server and the UI keeps the button hidden.

- **OAuth:** authorization-code flow with scope `openid profile w_member_social`. The single-use state is stored hashed in `oauth_states` (provider `linkedin`, ten-minute expiry) and must match the signed-in user, organization and client before it is consumed. LinkedIn's web-app flow authenticates the code exchange with the client secret; PKCE is only offered to native clients, so it is not used. A grant without `w_member_social` is refused (`LINKEDIN_SCOPE_MISSING`) and nothing is stored. The member ID comes from `/v2/userinfo` (`sub` → `urn:li:person:{sub}`).
- **Tokens:** access and refresh tokens are encrypted in `social_credentials` with `expires_at`; they never appear in logs or API responses. Plain member apps usually get no refresh token (about 60-day access tokens). An expired token is refreshed when a refresh token exists; otherwise, or when the refresh is refused, `token_health` becomes `EXPIRED`, publishing stops with `LINKEDIN_TOKEN_EXPIRED` and the user must reconnect.
- **Publishing:** `POST /rest/posts` with `LinkedIn-Version` and `X-Restli-Protocol-Version: 2.0.0`, author = person URN, commentary in LinkedIn's escaped "little" text format. An image is read from our own bucket, then `POST /rest/images?action=initializeUpload`, a `PUT` to the returned `*.linkedin.com` upload URL, and the post references the image URN. Other upload hosts are refused (`LINKEDIN_UPLOAD_URL_INVALID`). The `x-restli-id` header becomes the `provider_receipts` row (provider `linkedin`) and `post_targets.remote_id`.
- **Unsupported:** several images are refused by the shared limits when the draft is saved or scheduled (`MEDIA_UNSUPPORTED`/`VALIDATION`); a video → `LINKEDIN_MEDIA_UNSUPPORTED`; an organization author → `LINKEDIN_ORGANIZATION_UNSUPPORTED`. Both fail before any network call.
- **Uncertain delivery:** a timeout, network loss or 5xx on `POST /rest/posts`, or a success without `x-restli-id`, is `LINKEDIN_DELIVERY_UNCERTAIN`. It is never retried automatically; a reconciliation job is created as for Meta, but there is no LinkedIn lookup yet, so the job is closed as `UNRESOLVED` with `LINKEDIN_RECONCILIATION_MANUAL` and someone must check the profile. It never calls the Meta API.
- Other errors: `LINKEDIN_RATE_LIMIT` (retried), `LINKEDIN_UNAVAILABLE` (retried; only before the post request), `LINKEDIN_TOKEN_INVALID` (reconnect), `LINKEDIN_REJECTED`.
- Disconnecting revokes the token at LinkedIn on a best-effort basis and always deletes the local credential.

Company pages (Community Management API, `w_organization_social`) are a later round. TikTok and Google Business remain closed provider shells and return `PROVIDER_NOT_CONFIGURED`; their callback routes do not exchange tokens.

## Ayrshare

The configuration mode is reserved, but a working Ayrshare adapter is not implemented yet. Selecting it fails explicitly. An eventual adapter must use agency/client profiles and must reconcile uncertain remote delivery before retrying.

## Capability policy

The composer and scheduling service report unsupported combinations rather than silently discarding them. The MVP deliberately supports a conservative content subset. The current limits are local MVP validation limits, not a complete or permanently current statement of platform API limits. Official API integration must map account-specific permissions, API versions and media requirements.

Do not add scraping fallbacks. Durable receipts reduce duplicate delivery after confirmed responses but cannot close the crash/network ambiguity window around an external API call. Live delivery therefore remains at-least-once infrastructure with an explicit uncertain state, not an exactly-once guarantee.
