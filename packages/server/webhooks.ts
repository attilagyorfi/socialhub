import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import type { PoolClient } from "pg";
import { pool } from "../db";
import type { Role } from "../core/domain";
import { AppError, decrypt, encrypt } from "../core/security";
import type { Context } from "./context";
import { audit, transaction } from "./transaction";

// Signed outgoing webhooks of the /api/v1 integration contract. Events are
// written to the webhook_deliveries outbox in the same transaction as the post
// state change, and the worker delivers them with retries (see ARCHITECTURE.md).

export const webhookEvents = [
  "post.approved",
  "post.changes_requested",
  "post.published",
  "post.failed",
] as const;
export type WebhookEvent = (typeof webhookEvents)[number];

export const webhookSecretPrefix = "whsec_";
const visibleSecretChars = 6;
const maxActiveEndpoints = 10;
export const maxWebhookAttempts = 12;
export const webhookTimeoutMs = 5000;

export type Lookup = (
  hostname: string,
) => Promise<{ address: string; family: number }[]>;

const systemLookup: Lookup = (hostname) =>
  dnsLookup(hostname, { all: true, verbatim: true });

// ---------------------------------------------------------------------------
// SSRF protection

// Destinations that are never public: loopback, private, carrier-grade NAT,
// link-local (cloud metadata), documentation, benchmarking, multicast and
// reserved ranges. IPv4-mapped/compatible and NAT64 IPv6 forms are blocked
// whole so an internal IPv4 address cannot be reached through them. The two
// families use separate lists: BlockList matches IPv4 addresses against
// IPv4-mapped IPv6 rules, which would otherwise block every IPv4 address.
const blockedV4 = new BlockList();
const blockedV6 = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blockedV4.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 96],
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 32],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const)
  blockedV6.addSubnet(network, prefix, "ipv6");

export function isBlockedAddress(address: string) {
  const family = isIP(address);
  if (family === 4) return blockedV4.check(address, "ipv4");
  if (family === 6) return blockedV6.check(address, "ipv6");
  // Anything that is not a plain IP literal is refused.
  return true;
}

const blockedDestination = () =>
  new AppError(
    422,
    "WEBHOOK_URL_BLOCKED",
    "The webhook URL must be a public HTTPS address.",
  );

// Validates the URL and every address its host resolves to. Used when an
// endpoint is saved and again right before each delivery.
export async function assertPublicWebhookUrl(
  value: string,
  lookup: Lookup = systemLookup,
) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw blockedDestination();
  }
  if (url.protocol !== "https:" || url.username || url.password)
    throw blockedDestination();
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    !host ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  )
    throw blockedDestination();
  if (isIP(host)) {
    if (isBlockedAddress(host)) throw blockedDestination();
    return url;
  }
  let addresses: { address: string }[];
  try {
    addresses = await lookup(host);
  } catch {
    throw new AppError(
      422,
      "WEBHOOK_URL_UNRESOLVABLE",
      "The webhook host could not be resolved.",
    );
  }
  if (!addresses.length || addresses.some((a) => isBlockedAddress(a.address)))
    throw blockedDestination();
  return url;
}

// ---------------------------------------------------------------------------
// Endpoint management (owner/admin only)

function administrator(c: Context) {
  if (!(["OWNER", "ADMIN"] as Role[]).includes(c.role))
    throw new AppError(403, "FORBIDDEN", "Administrator access is required.");
}

export function generateWebhookSecret() {
  const raw = webhookSecretPrefix + randomBytes(32).toString("base64url");
  return {
    raw,
    prefix: raw.slice(0, webhookSecretPrefix.length + visibleSecretChars),
  };
}

const secretScope = (organizationId: string, id: string) =>
  `webhook-endpoint:${organizationId}:${id}`;

const endpointColumns =
  "id,url,events,secret_prefix,created_at,secret_rotated_at,revoked_at";

export async function listWebhookEndpoints(c: Context) {
  administrator(c);
  return (
    await pool.query(
      `SELECT ${endpointColumns} FROM webhook_endpoints
       WHERE organization_id=$1
       ORDER BY revoked_at IS NOT NULL,created_at DESC LIMIT 100`,
      [c.organizationId],
    )
  ).rows;
}

export async function createWebhookEndpoint(
  c: Context,
  input: { url: string; events: WebhookEvent[] },
  lookup: Lookup = systemLookup,
) {
  administrator(c);
  const url = (await assertPublicWebhookUrl(input.url, lookup)).toString();
  const events = webhookEvents.filter((event) => input.events.includes(event));
  if (!events.length)
    throw new AppError(422, "VALIDATION", "Choose at least one event.");
  const secret = generateWebhookSecret();
  const id = randomUUID();
  const row = await transaction(async (tx) => {
    // Serializes concurrent creations so the active-endpoint limit holds.
    await tx.query("SELECT 1 FROM organizations WHERE id=$1 FOR UPDATE", [
      c.organizationId,
    ]);
    const active = await tx.query(
      "SELECT count(*)::int AS count FROM webhook_endpoints WHERE organization_id=$1 AND revoked_at IS NULL",
      [c.organizationId],
    );
    if (active.rows[0].count >= maxActiveEndpoints)
      throw new AppError(
        409,
        "WEBHOOK_LIMIT",
        "Revoke an unused webhook before adding a new one.",
      );
    const created = (
      await tx.query(
        `INSERT INTO webhook_endpoints(
           id,organization_id,url,secret_ciphertext,secret_prefix,events,created_by_user_id
         ) VALUES($1,$2,$3,$4,$5,$6,$7)
         RETURNING ${endpointColumns}`,
        [
          id,
          c.organizationId,
          url,
          encrypt(secret.raw, secretScope(c.organizationId, id)),
          secret.prefix,
          events,
          c.userId,
        ],
      )
    ).rows[0];
    // The host only: query strings may carry receiver-side tokens.
    await audit(tx, c, "webhook.created", id, {
      host: new URL(url).host,
      events,
      prefix: secret.prefix,
    });
    return created;
  });
  // The raw secret is returned only here and after rotation.
  return { ...row, secret: secret.raw };
}

export async function revokeWebhookEndpoint(c: Context, id: string) {
  administrator(c);
  return transaction(async (tx) => {
    const row = (
      await tx.query(
        `UPDATE webhook_endpoints
         SET revoked_at=now(),revoked_by_user_id=$3,updated_at=now()
         WHERE id=$1 AND organization_id=$2 AND revoked_at IS NULL
         RETURNING ${endpointColumns}`,
        [id, c.organizationId, c.userId],
      )
    ).rows[0];
    if (!row) throw new AppError(404, "NOT_FOUND", "Webhook not found.");
    // Waiting deliveries are never sent to a revoked endpoint.
    const dropped = await tx.query(
      `UPDATE webhook_deliveries
       SET status='DEAD',last_error='ENDPOINT_REVOKED',completed_at=now(),updated_at=now()
       WHERE endpoint_id=$1 AND status IN ('PENDING','RETRY')`,
      [id],
    );
    await audit(tx, c, "webhook.revoked", id, {
      host: new URL(row.url).host,
      prefix: row.secret_prefix,
      droppedDeliveries: dropped.rowCount ?? 0,
    });
    return row;
  });
}

export async function rotateWebhookSecret(c: Context, id: string) {
  administrator(c);
  const secret = generateWebhookSecret();
  const row = await transaction(async (tx) => {
    const updated = (
      await tx.query(
        `UPDATE webhook_endpoints
         SET secret_ciphertext=$3,secret_prefix=$4,secret_rotated_at=now(),updated_at=now()
         WHERE id=$1 AND organization_id=$2 AND revoked_at IS NULL
         RETURNING ${endpointColumns}`,
        [
          id,
          c.organizationId,
          encrypt(secret.raw, secretScope(c.organizationId, id)),
          secret.prefix,
        ],
      )
    ).rows[0];
    if (!updated) throw new AppError(404, "NOT_FOUND", "Webhook not found.");
    await audit(tx, c, "webhook.secret_rotated", id, {
      host: new URL(updated.url).host,
      prefix: secret.prefix,
    });
    return updated;
  });
  return { ...row, secret: secret.raw };
}

// ---------------------------------------------------------------------------
// Event capture (inside the caller's transaction)

export type WebhookEventInput = {
  organizationId: string;
  clientId: string;
  postId: string;
  status: string;
  postTargetId?: string;
  platform?: string;
  platformPostId?: string | null;
  publishedUrl?: string | null;
  errorCode?: string | null;
};

// Writes one outbox row per active endpoint of the organization subscribed to
// the event. Must be called with the transaction of the state change so the
// event exists exactly when the change is committed. Only identifiers and
// status codes go into the payload: never captions, tokens or secrets.
export async function enqueueWebhookEvent(
  tx: PoolClient,
  type: WebhookEvent,
  input: WebhookEventInput,
) {
  const endpoints = (
    await tx.query(
      `SELECT id FROM webhook_endpoints
       WHERE organization_id=$1 AND revoked_at IS NULL AND $2=ANY(events)
       ORDER BY created_at`,
      [input.organizationId, type],
    )
  ).rows;
  if (!endpoints.length) return 0;
  const client = (
    await tx.query(
      "SELECT external_ref FROM clients WHERE id=$1 AND organization_id=$2",
      [input.clientId, input.organizationId],
    )
  ).rows[0];
  const data: Record<string, string | null> = {
    post_id: input.postId,
    client_id: input.clientId,
    client_external_ref: client?.external_ref ?? null,
    organization_id: input.organizationId,
    status: input.status,
  };
  if (input.postTargetId) {
    data.post_target_id = input.postTargetId;
    data.platform = input.platform ?? null;
    if (input.platformPostId) data.platform_post_id = input.platformPostId;
    if (input.publishedUrl) data.published_url = input.publishedUrl;
  }
  if (input.errorCode) data.error_code = input.errorCode;
  const createdAt = new Date().toISOString();
  for (const endpoint of endpoints) {
    const eventId = randomUUID();
    await tx.query(
      `INSERT INTO webhook_deliveries(
         event_id,organization_id,client_id,endpoint_id,event_type,payload
       ) VALUES($1,$2,$3,$4,$5,$6)`,
      [
        eventId,
        input.organizationId,
        input.clientId,
        endpoint.id,
        type,
        JSON.stringify({ id: eventId, type, created_at: createdAt, data }),
      ],
    );
  }
  return endpoints.length;
}

// ---------------------------------------------------------------------------
// Delivery

// Hex HMAC-SHA256 of `${timestamp}.${body}` keyed with the endpoint secret.
export function signWebhook(secret: string, timestamp: number, body: string) {
  return (
    "sha256=" +
    createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")
  );
}

export type WebhookTransport = {
  fetch: typeof fetch;
  lookup: Lookup;
  now: () => number;
};

const defaultTransport: WebhookTransport = {
  fetch: (...args) => fetch(...args),
  lookup: systemLookup,
  now: () => Date.now(),
};

type SendResult =
  | { ok: true; statusCode: number }
  | { ok: false; error: string; statusCode?: number };

export async function sendWebhook(
  delivery: { url: string; secret: string; eventId: string; type: string },
  body: string,
  transport: WebhookTransport = defaultTransport,
): Promise<SendResult> {
  try {
    // DNS is checked again right before sending (see SECURITY.md about the
    // remaining DNS-rebinding window).
    await assertPublicWebhookUrl(delivery.url, transport.lookup);
  } catch (e) {
    return {
      ok: false,
      error: e instanceof AppError ? e.code : "WEBHOOK_URL_BLOCKED",
    };
  }
  const timestamp = Math.floor(transport.now() / 1000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), webhookTimeoutMs);
  try {
    const response = await transport.fetch(delivery.url, {
      method: "POST",
      redirect: "manual",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "SocialHub-Webhooks/1",
        "X-SocialHub-Event-Id": delivery.eventId,
        "X-SocialHub-Event": delivery.type,
        "X-SocialHub-Timestamp": String(timestamp),
        "X-SocialHub-Signature": signWebhook(delivery.secret, timestamp, body),
      },
      body,
    });
    // The receiver's body is never read or stored.
    await response.body?.cancel().catch(() => {});
    if (response.status >= 200 && response.status < 300)
      return { ok: true, statusCode: response.status };
    return {
      ok: false,
      statusCode: response.status,
      error:
        response.status >= 300 && response.status < 400
          ? "WEBHOOK_REDIRECT"
          : "WEBHOOK_HTTP_ERROR",
    };
  } catch {
    return {
      ok: false,
      error: controller.signal.aborted ? "WEBHOOK_TIMEOUT" : "WEBHOOK_NETWORK",
    };
  } finally {
    clearTimeout(timer);
  }
}

export const webhookRetrySeconds = (attempt: number) =>
  Math.min(3600, 5 * 2 ** (attempt - 1));

type ClaimedDelivery = {
  id: string;
  event_id: string;
  event_type: string;
  payload: unknown;
  attempts: number;
  url: string;
  secret: string;
  organization_id: string;
};

async function claimDelivery(organizationId?: string) {
  return transaction(async (tx) => {
    const row = (
      await tx.query(
        `SELECT d.id,d.event_id,d.event_type,d.payload,d.attempts,d.organization_id,
                d.endpoint_id,e.url,e.secret_ciphertext,e.revoked_at
         FROM webhook_deliveries d
         JOIN webhook_endpoints e ON e.id=d.endpoint_id
         WHERE d.status IN ('PENDING','RETRY') AND d.run_at<=now()
           AND ($1::uuid IS NULL OR d.organization_id=$1)
         ORDER BY d.run_at,d.created_at LIMIT 1
         FOR UPDATE OF d SKIP LOCKED`,
        [organizationId ?? null],
      )
    ).rows[0];
    if (!row) return null;
    if (row.revoked_at) {
      await tx.query(
        `UPDATE webhook_deliveries
         SET status='DEAD',last_error='ENDPOINT_REVOKED',completed_at=now(),updated_at=now()
         WHERE id=$1`,
        [row.id],
      );
      return { skipped: true as const };
    }
    const attempts = Number(row.attempts) + 1;
    let secret: string;
    try {
      // The current secret signs the request, so a rotation applies to
      // deliveries that are still waiting.
      secret = decrypt(
        row.secret_ciphertext,
        secretScope(row.organization_id, row.endpoint_id),
      );
    } catch {
      await tx.query(
        `UPDATE webhook_deliveries
         SET status='DEAD',attempts=$2,last_error='WEBHOOK_SECRET_UNAVAILABLE',
             completed_at=now(),updated_at=now()
         WHERE id=$1`,
        [row.id, attempts],
      );
      return { skipped: true as const };
    }
    await tx.query(
      `UPDATE webhook_deliveries
       SET status='RUNNING',attempts=$2,started_at=now(),updated_at=now()
       WHERE id=$1`,
      [row.id, attempts],
    );
    return {
      skipped: false as const,
      delivery: {
        id: String(row.id),
        event_id: String(row.event_id),
        event_type: String(row.event_type),
        payload: row.payload,
        attempts,
        url: String(row.url),
        secret,
        organization_id: String(row.organization_id),
      } satisfies ClaimedDelivery,
    };
  });
}

export async function processWebhookDeliveries(
  limit = 50,
  transport: WebhookTransport = defaultTransport,
  organizationId?: string,
) {
  // A worker that died mid-request leaves a RUNNING row behind.
  await pool.query(
    `UPDATE webhook_deliveries
     SET status=CASE WHEN attempts>=$1 THEN 'DEAD' ELSE 'RETRY' END,
         last_error='WEBHOOK_INTERRUPTED',run_at=now(),updated_at=now()
     WHERE status='RUNNING' AND started_at<now()-interval '5 minutes'`,
    [maxWebhookAttempts],
  );
  let delivered = 0;
  let retried = 0;
  let failed = 0;
  let skipped = 0;
  for (let index = 0; index < Math.max(1, Math.min(limit, 100)); index++) {
    const claim = await claimDelivery(organizationId);
    if (!claim) break;
    if (claim.skipped) {
      skipped++;
      continue;
    }
    const { delivery } = claim;
    const body =
      typeof delivery.payload === "string"
        ? delivery.payload
        : JSON.stringify(delivery.payload);
    const result = await sendWebhook(
      {
        url: delivery.url,
        secret: delivery.secret,
        eventId: delivery.event_id,
        type: delivery.event_type,
      },
      body,
      transport,
    );
    if (result.ok) {
      await pool.query(
        `UPDATE webhook_deliveries
         SET status='DONE',last_error=NULL,last_status_code=$3,
             completed_at=now(),updated_at=now()
         WHERE id=$1 AND status='RUNNING' AND attempts=$2`,
        [delivery.id, delivery.attempts, result.statusCode],
      );
      delivered++;
      continue;
    }
    const retry = delivery.attempts < maxWebhookAttempts;
    await pool.query(
      `UPDATE webhook_deliveries
       SET status=$3,last_error=$4,last_status_code=$5,
           run_at=now()+($6 * interval '1 second'),
           completed_at=CASE WHEN $3='DEAD' THEN now() ELSE NULL END,
           updated_at=now()
       WHERE id=$1 AND status='RUNNING' AND attempts=$2`,
      [
        delivery.id,
        delivery.attempts,
        retry ? "RETRY" : "DEAD",
        result.error,
        result.statusCode ?? null,
        webhookRetrySeconds(delivery.attempts),
      ],
    );
    if (retry) retried++;
    else failed++;
    console.error(
      JSON.stringify({
        event: "webhook_delivery_failed",
        deliveryId: delivery.id,
        code: result.error,
        statusCode: result.statusCode,
        retry,
      }),
    );
  }
  return { delivered, retried, failed, skipped };
}
