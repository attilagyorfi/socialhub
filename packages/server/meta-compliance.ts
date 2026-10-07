import { createHmac, timingSafeEqual } from "node:crypto";
import { pool } from "../db";
import { AppError, hashToken, token } from "../core/security";
import { detachMetaAccounts, findMetaGrantAccounts, metaConfig } from "./meta";
import { transaction } from "./transaction";

function base64url(value: string) {
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

// Meta's signed_request: "<signature>.<payload>", both base64url, signed with
// HMAC-SHA256 of the encoded payload using the app secret.
export function parseSignedRequest(signedRequest: unknown, appSecret: string) {
  const invalid = new AppError(
    400,
    "META_SIGNED_REQUEST_INVALID",
    "Invalid signed request.",
  );
  if (typeof signedRequest !== "string" || signedRequest.length > 4096)
    throw invalid;
  const [encodedSignature, encodedPayload, extra] = signedRequest.split(".");
  if (!encodedSignature || !encodedPayload || extra !== undefined)
    throw invalid;
  const expected = createHmac("sha256", appSecret)
    .update(encodedPayload)
    .digest();
  const signature = base64url(encodedSignature);
  if (
    signature.length !== expected.length ||
    !timingSafeEqual(signature, expected)
  )
    throw invalid;
  let payload: { algorithm?: unknown; user_id?: unknown };
  try {
    payload = JSON.parse(base64url(encodedPayload).toString("utf8"));
  } catch {
    throw invalid;
  }
  if (
    String(payload.algorithm).toUpperCase() !== "HMAC-SHA256" ||
    (typeof payload.user_id !== "string" && typeof payload.user_id !== "number")
  )
    throw invalid;
  return { userId: String(payload.user_id) };
}

async function detachGrant(
  userId: string,
  action: "meta.deauthorized" | "meta.data_deletion",
  eraseProfile: boolean,
) {
  const accounts = await findMetaGrantAccounts(userId);
  if (!accounts.length) return 0;
  const ids = accounts.map((account) => account.id);
  await transaction(async (tx) => {
    await detachMetaAccounts(tx, ids);
    // Page pictures come from the person's grant; drop them on deletion.
    if (eraseProfile)
      await tx.query(
        "UPDATE social_accounts SET avatar=NULL WHERE id=ANY($1::uuid[])",
        [ids],
      );
    for (const account of accounts)
      await tx.query(
        `INSERT INTO audit_logs(organization_id,client_id,action,resource_id,metadata)
         VALUES($1,$2,$3,$4,$5)`,
        [
          account.organizationId,
          account.clientId,
          action,
          account.id,
          JSON.stringify({ provider: "meta" }),
        ],
      );
  });
  return ids.length;
}

// Deauthorize callback: the person removed the app in their Meta settings.
export async function handleMetaDeauthorize(signedRequest: unknown) {
  const { userId } = parseSignedRequest(signedRequest, metaConfig().appSecret);
  return {
    disconnected: await detachGrant(userId, "meta.deauthorized", false),
  };
}

// Data deletion callback: delete what the person's grant gave us and return
// the confirmation code and status URL Meta shows them.
export async function handleMetaDataDeletion(signedRequest: unknown) {
  const { userId } = parseSignedRequest(signedRequest, metaConfig().appSecret);
  const disconnected = await detachGrant(userId, "meta.data_deletion", true);
  const confirmationCode = token().slice(0, 16);
  await pool.query(
    `INSERT INTO meta_data_deletion_requests(
       confirmation_code,user_hash,status,accounts_disconnected,completed_at
     ) VALUES($1,$2,'COMPLETED',$3,now())`,
    [confirmationCode, hashToken(`meta-user:${userId}`), disconnected],
  );
  return {
    url: `${process.env.APP_URL}/meta/deletion/${confirmationCode}`,
    confirmation_code: confirmationCode,
  };
}

export async function metaDeletionStatus(confirmationCode: string) {
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(confirmationCode)) return null;
  const row = (
    await pool.query(
      `SELECT status,created_at,completed_at
       FROM meta_data_deletion_requests WHERE confirmation_code=$1`,
      [confirmationCode],
    )
  ).rows[0];
  return row
    ? {
        status: row.status as "COMPLETED",
        createdAt: row.created_at as Date,
        completedAt: row.completed_at as Date | null,
      }
    : null;
}
