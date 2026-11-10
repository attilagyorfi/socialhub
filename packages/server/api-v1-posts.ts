import { createHash } from "node:crypto";
import { z } from "zod";
import { pool } from "../db";
import type { Status } from "../core/domain";
import { AppError } from "../core/security";
import type { ApiKeyContext } from "./api-keys";
import { insertDraftPost } from "./posts";
import { audit, transaction } from "./transaction";
import { uuid } from "./validation";

export const maxDraftsPerRequest = 50;
export const maxTargetsPerDraft = 15;
export const maxMediaUrlsPerDraft = 10;
export const defaultPostsLimit = 50;
export const maxPostsLimit = 200;
// A stored Idempotency-Key response is replayed for this long; after that
// the same key runs as a new request and the worker deletes the old row.
export const idempotencyWindowHours = 24;

// Integration status categories of the v1 contract. `raw_status` carries the
// exact post_status next to it, so finer distinctions are never lost.
export type ApiPostStatus =
  | "draft"
  | "pending_approval"
  | "scheduled"
  | "published"
  | "failed"
  | "cancelled";

export const apiStatusCategory: Record<Status, ApiPostStatus> = {
  DRAFT: "draft",
  PENDING_APPROVAL: "pending_approval",
  APPROVED: "scheduled",
  SCHEDULED: "scheduled",
  QUEUED: "scheduled",
  PUBLISHING: "scheduled",
  PUBLISHED: "published",
  PARTIALLY_PUBLISHED: "published",
  FAILED: "failed",
  // Withdrawn by a user; it will not be published unless it is recreated.
  CANCELLED: "cancelled",
};

const notBlank = (value: string) => value.trim().length > 0;
const text = z.string().max(63206).refine(notBlank, "Text cannot be empty.");
const label = z.string().max(100).refine(notBlank, "Labels cannot be empty.");
const httpsUrl = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password;
    } catch {
      return false;
    }
  }, "Media URLs must be HTTPS links.");

const draftInput = z
  .object({
    text,
    targets: z
      .array(
        z.object({ social_account_id: uuid, text: text.optional() }).strict(),
      )
      .min(1)
      .max(maxTargetsPerDraft),
    suggested_at: z.iso.datetime({ offset: true }).optional(),
    media_urls: z.array(httpsUrl).max(maxMediaUrlsPerDraft).optional(),
    pillar: label.optional(),
    source: label.optional(),
  })
  .strict();

export const draftsInput = z
  .object({
    drafts: z.array(draftInput).min(1).max(maxDraftsPerRequest),
  })
  .strict();

const idempotencyKeyPattern = /^[A-Za-z0-9._:-]{8,128}$/;

export function parseIdempotencyKey(value: string | null) {
  const key = value?.trim() ?? "";
  if (!idempotencyKeyPattern.test(key))
    throw new AppError(
      400,
      "INVALID_IDEMPOTENCY_KEY",
      "Send an Idempotency-Key header of 8–128 letters, digits or . _ : - characters.",
    );
  return key;
}

function validationError(error: z.ZodError) {
  return new AppError(
    422,
    "VALIDATION",
    error.issues
      .slice(0, 10)
      .map((issue) =>
        issue.path.length
          ? `${issue.path.join(".")}: ${issue.message}`
          : issue.message,
      )
      .join(" "),
  );
}

// Key order does not change the hash, so a client that re-serializes the same
// request still gets a replay.
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map(
        (k) =>
          `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value);
}

export const requestHash = (clientId: string, drafts: unknown) =>
  createHash("sha256")
    .update(canonical({ client_id: clientId, drafts }))
    .digest("hex");

const clientNotFound = () =>
  new AppError(404, "NOT_FOUND", "Client not found.");

export type ApiReply = { status: number; body: unknown; replayed: boolean };

// POST /api/v1/clients/{id}/drafts. The whole batch, its audit events and the
// idempotency record commit together or not at all. Posts are always DRAFT:
// suggested_at is metadata, so nothing is scheduled, queued or sent for
// approval.
export async function createApiDrafts(
  key: ApiKeyContext,
  clientId: string,
  idempotencyKey: string,
  body: unknown,
): Promise<ApiReply> {
  const parsed = draftsInput.safeParse(body);
  if (!parsed.success) throw validationError(parsed.error);
  const drafts = parsed.data.drafts;
  for (const [index, draft] of drafts.entries()) {
    const accounts = draft.targets.map((t) => t.social_account_id);
    if (new Set(accounts).size !== accounts.length)
      throw new AppError(
        422,
        "DUPLICATE_TARGET",
        `drafts.${index}.targets: Use each social account only once per draft.`,
      );
  }
  if (!uuid.safeParse(clientId).success) throw clientNotFound();
  const hash = requestHash(clientId, drafts);

  return transaction(async (tx) => {
    // An expired record is not replayed, even before the worker removes it.
    await tx.query(
      `DELETE FROM api_idempotency_keys
       WHERE organization_id=$1 AND key=$2 AND created_at<now()-$3*interval '1 hour'`,
      [key.organizationId, idempotencyKey, idempotencyWindowHours],
    );
    // A concurrent request holding the same key blocks here until it commits
    // (then this one replays) or rolls back (then this one proceeds).
    const claimed = (
      await tx.query(
        `INSERT INTO api_idempotency_keys(organization_id,api_key_id,key,request_hash,response_status,response_body)
         VALUES($1,$2,$3,$4,201,'{}')
         ON CONFLICT(organization_id,key) DO NOTHING RETURNING id`,
        [key.organizationId, key.keyId, idempotencyKey, hash],
      )
    ).rows[0];
    if (!claimed) {
      const stored = (
        await tx.query(
          `SELECT request_hash,response_status,response_body FROM api_idempotency_keys
           WHERE organization_id=$1 AND key=$2`,
          [key.organizationId, idempotencyKey],
        )
      ).rows[0];
      if (!stored)
        throw new AppError(
          409,
          "IDEMPOTENCY_IN_PROGRESS",
          "A request with this Idempotency-Key is still being processed. Retry shortly.",
        );
      if (stored.request_hash !== hash)
        throw new AppError(
          422,
          "IDEMPOTENCY_KEY_REUSED",
          "This Idempotency-Key was already used for a different request.",
        );
      return {
        status: Number(stored.response_status),
        body: stored.response_body,
        replayed: true,
      };
    }

    const client = (
      await tx.query(
        "SELECT id FROM clients WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL FOR SHARE",
        [clientId, key.organizationId],
      )
    ).rows[0];
    if (!client) throw clientNotFound();

    const accountIds = [
      ...new Set(
        drafts.flatMap((d) => d.targets.map((t) => t.social_account_id)),
      ),
    ];
    const accounts = new Map<string, string>(
      (
        await tx.query(
          `SELECT id,status FROM social_accounts
           WHERE organization_id=$1 AND client_id=$2 AND id=ANY($3::uuid[]) AND deleted_at IS NULL`,
          [key.organizationId, clientId, accountIds],
        )
      ).rows.map((row) => [String(row.id), String(row.status)]),
    );
    for (const id of accountIds) {
      const status = accounts.get(id);
      if (!status)
        throw new AppError(
          404,
          "ACCOUNT_NOT_FOUND",
          `Social account ${id} was not found for this client.`,
        );
      if (status !== "CONNECTED")
        throw new AppError(
          422,
          "ACCOUNT_NOT_CONNECTED",
          `Social account ${id} must be reconnected before drafts can target it.`,
        );
    }

    const actor = {
      organizationId: key.organizationId,
      clientId,
      userId: null,
    };
    const created: { id: string; status: ApiPostStatus; raw_status: Status }[] =
      [];
    for (const draft of drafts) {
      const input = {
        caption: draft.text,
        targets: draft.targets.map((t) => ({
          accountId: t.social_account_id,
          caption: t.text ?? draft.text,
          mediaIds: [],
        })),
      };
      const metadata = {
        suggestedAt: draft.suggested_at ?? null,
        pillar: draft.pillar ?? null,
        source: draft.source ?? null,
        mediaUrls: draft.media_urls ?? null,
      };
      const post = await insertDraftPost(
        tx,
        { organizationId: key.organizationId, clientId, authorId: null },
        input,
        { clientId, ...input, ...metadata },
        metadata,
      );
      await audit(tx, actor, "post.created", post.id, {
        source: "api",
        api_key_id: key.keyId,
      });
      created.push({
        id: String(post.id),
        status: "draft",
        raw_status: "DRAFT",
      });
    }

    const response = { data: created };
    await tx.query(
      "UPDATE api_idempotency_keys SET response_body=$2 WHERE id=$1",
      [claimed.id, JSON.stringify(response)],
    );
    return { status: 201, body: response, replayed: false };
  });
}

const listQuery = z.object({
  client: uuid.optional(),
  since: z.iso.datetime({ offset: true }).optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(maxPostsLimit)
    .default(defaultPostsLimit),
  cursor: z.string().max(500).optional(),
});

const cursorShape = z.object({
  updatedAt: z.iso.datetime({ offset: true }),
  id: uuid,
});

function decodeCursor(value: string) {
  try {
    return cursorShape.parse(
      JSON.parse(Buffer.from(value, "base64url").toString("utf8")),
    );
  } catch {
    throw new AppError(
      400,
      "INVALID_CURSOR",
      "The cursor is invalid. Start again without it.",
    );
  }
}

const iso = (value: unknown) =>
  value instanceof Date
    ? value.toISOString()
    : value == null
      ? null
      : new Date(String(value)).toISOString();

type TargetRow = {
  id: string;
  social_account_id: string;
  network: string;
  status: Status;
  published_at: string | null;
  error_code: string | null;
};

// GET /api/v1/posts. Pages ascend by (updated_at,id) so a poller can resume
// from its last `since` or follow `next_cursor` without skipping rows.
export async function listApiPosts(
  key: ApiKeyContext,
  params: URLSearchParams,
) {
  const parsed = listQuery.safeParse({
    client: params.get("client") ?? undefined,
    since: params.get("since") ?? undefined,
    limit: params.get("limit") ?? undefined,
    cursor: params.get("cursor") ?? undefined,
  });
  if (!parsed.success)
    throw new AppError(
      400,
      "INVALID_QUERY",
      parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join(" "),
    );
  const query = parsed.data;
  const values: unknown[] = [key.organizationId];
  const conditions = ["p.organization_id=$1", "p.deleted_at IS NULL"];
  if (query.client) {
    const client = (
      await pool.query(
        "SELECT 1 FROM clients WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL",
        [query.client, key.organizationId],
      )
    ).rows.length;
    if (!client) throw clientNotFound();
    values.push(query.client);
    conditions.push(`p.client_id=$${values.length}`);
  }
  if (query.since) {
    values.push(query.since);
    conditions.push(`p.updated_at>=$${values.length}::timestamptz`);
  }
  if (query.cursor) {
    const cursor = decodeCursor(query.cursor);
    values.push(cursor.updatedAt, cursor.id);
    conditions.push(
      `(p.updated_at,p.id)>($${values.length - 1}::timestamptz,$${values.length}::uuid)`,
    );
  }
  values.push(query.limit + 1);
  const rows = (
    await pool.query(
      `SELECT p.id,p.client_id,p.status,p.scheduled_at,p.suggested_at,p.pillar,
         p.source,p.media_urls,p.created_at,p.updated_at,
         to_char(p.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
           AS cursor_updated_at,
         coalesce((
           SELECT jsonb_agg(jsonb_build_object(
             'id',t.id,'social_account_id',t.social_account_id,
             'network',a.platform,'status',t.status,
             'published_at',t.published_at,'error_code',t.error_code
           ) ORDER BY t.created_at,t.id)
           FROM post_targets t JOIN social_accounts a ON a.id=t.social_account_id
           WHERE t.post_id=p.id
         ),'[]'::jsonb) AS targets
       FROM posts p
       JOIN clients c ON c.organization_id=p.organization_id AND c.id=p.client_id
         AND c.deleted_at IS NULL
       WHERE ${conditions.join(" AND ")}
       ORDER BY p.updated_at,p.id
       LIMIT $${values.length}`,
      values,
    )
  ).rows;
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  return {
    data: page.map((row) => ({
      id: String(row.id),
      client_id: String(row.client_id),
      status: apiStatusCategory[row.status as Status],
      raw_status: row.status as Status,
      scheduled_at: iso(row.scheduled_at),
      suggested_at: iso(row.suggested_at),
      pillar: row.pillar ?? null,
      source: row.source ?? null,
      media_urls: (row.media_urls as string[] | null) ?? [],
      created_at: iso(row.created_at),
      updated_at: iso(row.updated_at),
      targets: (row.targets as TargetRow[]).map((target) => ({
        id: target.id,
        social_account_id: target.social_account_id,
        network: target.network,
        status: apiStatusCategory[target.status],
        raw_status: target.status,
        published_at: iso(target.published_at),
        error_code: target.error_code,
      })),
    })),
    next_cursor:
      rows.length > query.limit && last
        ? Buffer.from(
            JSON.stringify({
              updatedAt: last.cursor_updated_at,
              id: String(last.id),
            }),
          ).toString("base64url")
        : null,
  };
}

// Worker retention: deletes expired Idempotency-Key records in small batches
// so one run never holds long locks; the rest waits for the next run.
export async function cleanupExpiredIdempotencyKeys(
  batchSize = 1000,
  maxBatches = 20,
) {
  let deleted = 0;
  for (let batch = 0; batch < maxBatches; batch++) {
    const removed = (
      await pool.query(
        `DELETE FROM api_idempotency_keys WHERE id IN (
           SELECT id FROM api_idempotency_keys
           WHERE created_at<now()-$1*interval '1 hour'
           ORDER BY created_at LIMIT $2
         ) RETURNING id`,
        [idempotencyWindowHours, batchSize],
      )
    ).rows.length;
    deleted += removed;
    if (removed < batchSize) break;
  }
  return deleted;
}
