import { randomBytes } from "node:crypto";
import { pool } from "../db";
import type { Role } from "../core/domain";
import { AppError, hashToken } from "../core/security";
import type { Context } from "./context";
import { audit, transaction } from "./transaction";

// Raw keys look like `shk_live_<43 base64url chars>` (32 random bytes). Only
// the SHA-256 hex hash is stored; the prefix plus a few characters identify
// the key in lists without revealing a usable part of the secret.
export const apiKeyPrefix = "shk_live_";
const visibleSecretChars = 6;
const maxActiveKeys = 20;

export function generateApiKey() {
  const raw = apiKeyPrefix + randomBytes(32).toString("base64url");
  return {
    raw,
    prefix: raw.slice(0, apiKeyPrefix.length + visibleSecretChars),
    hash: hashToken(raw),
  };
}

function administrator(c: Context) {
  if (!(["OWNER", "ADMIN"] as Role[]).includes(c.role))
    throw new AppError(403, "FORBIDDEN", "Administrator access is required.");
}

export async function listApiKeys(c: Context) {
  administrator(c);
  return (
    await pool.query(
      `SELECT id,name,key_prefix,created_at,last_used_at,revoked_at
       FROM api_keys WHERE organization_id=$1
       ORDER BY revoked_at IS NOT NULL,created_at DESC LIMIT 100`,
      [c.organizationId],
    )
  ).rows;
}

export async function createApiKey(c: Context, name: string) {
  administrator(c);
  const key = generateApiKey();
  const row = await transaction(async (tx) => {
    // Serializes concurrent creations so the active-key limit holds.
    await tx.query("SELECT 1 FROM organizations WHERE id=$1 FOR UPDATE", [
      c.organizationId,
    ]);
    const active = await tx.query(
      "SELECT count(*)::int AS count FROM api_keys WHERE organization_id=$1 AND revoked_at IS NULL",
      [c.organizationId],
    );
    if (active.rows[0].count >= maxActiveKeys)
      throw new AppError(
        409,
        "API_KEY_LIMIT",
        "Revoke an unused API key before creating a new one.",
      );
    const created = (
      await tx.query(
        `INSERT INTO api_keys(organization_id,name,key_prefix,key_hash,created_by_user_id)
         VALUES($1,$2,$3,$4,$5)
         RETURNING id,name,key_prefix,created_at,last_used_at,revoked_at`,
        [c.organizationId, name, key.prefix, key.hash, c.userId],
      )
    ).rows[0];
    await audit(tx, c, "api_key.created", created.id, {
      name,
      prefix: key.prefix,
    });
    return created;
  });
  // The raw key is returned only here; it cannot be recovered later.
  return { ...row, key: key.raw };
}

export async function revokeApiKey(c: Context, id: string) {
  administrator(c);
  return transaction(async (tx) => {
    const row = (
      await tx.query(
        `UPDATE api_keys SET revoked_at=now(),revoked_by_user_id=$3
         WHERE id=$1 AND organization_id=$2 AND revoked_at IS NULL
         RETURNING id,name,key_prefix,created_at,last_used_at,revoked_at`,
        [id, c.organizationId, c.userId],
      )
    ).rows[0];
    if (!row) throw new AppError(404, "NOT_FOUND", "API key not found.");
    await audit(tx, c, "api_key.revoked", row.id, {
      name: row.name,
      prefix: row.key_prefix,
    });
    return row;
  });
}

// Missing, malformed, unknown and revoked keys all produce the same error so
// callers cannot tell which keys exist.
export const invalidApiKey = () =>
  new AppError(401, "INVALID_API_KEY", "A valid API key is required.");

export type ApiKeyContext = { keyId: string; organizationId: string };

export async function authenticateApiKey(
  request: Request,
): Promise<ApiKeyContext> {
  const match = /^Bearer ([A-Za-z0-9_-]{1,200})$/.exec(
    request.headers.get("authorization")?.trim() ?? "",
  );
  if (!match || !match[1].startsWith(apiKeyPrefix)) throw invalidApiKey();
  const row = (
    await pool.query(
      `UPDATE api_keys k SET last_used_at=now()
       FROM organizations o
       WHERE k.key_hash=$1 AND k.revoked_at IS NULL
         AND o.id=k.organization_id AND o.deleted_at IS NULL
       RETURNING k.id,k.organization_id`,
      [hashToken(match[1])],
    )
  ).rows[0];
  if (!row) throw invalidApiKey();
  return { keyId: String(row.id), organizationId: String(row.organization_id) };
}

// GET /api/v1/clients: an explicit column list keeps remote IDs, provider
// capabilities and credentials out of the integration response.
export async function listIntegrationClients(organizationId: string) {
  const result = await pool.query(
    `SELECT c.id,c.name,
       coalesce(jsonb_agg(jsonb_build_object(
         'id',a.id,'platform',a.platform,'name',a.name,'status',a.status
       ) ORDER BY a.created_at,a.id) FILTER (WHERE a.id IS NOT NULL),'[]'::jsonb) AS accounts
     FROM clients c
     LEFT JOIN social_accounts a ON a.organization_id=c.organization_id
       AND a.client_id=c.id AND a.deleted_at IS NULL
     WHERE c.organization_id=$1 AND c.deleted_at IS NULL
     GROUP BY c.id ORDER BY c.name,c.id`,
    [organizationId],
  );
  return result.rows.map((row) => ({
    id: String(row.id),
    name: String(row.name),
    external_ref: null,
    accounts: row.accounts as {
      id: string;
      platform: string;
      name: string;
      status: string;
    }[],
  }));
}
