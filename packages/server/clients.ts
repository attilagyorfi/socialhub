import { pool } from "../db";
import { transaction, audit } from "./transaction";
import type { Context } from "./context";
import { capabilities, type Platform } from "../core/domain";
import { encrypt, AppError } from "../core/security";
import { disconnectMeta } from "./meta";
export async function listClients(userId: string) {
  return (
    await pool.query(
      `SELECT c.*,CASE WHEN om.role IN ('OWNER','ADMIN') THEN om.role ELSE cm.role END AS role FROM clients c JOIN organizations o ON o.id=c.organization_id AND o.deleted_at IS NULL JOIN organization_members om ON om.organization_id=c.organization_id AND om.user_id=$1 LEFT JOIN client_members cm ON cm.organization_id=c.organization_id AND cm.client_id=c.id AND cm.user_id=$1 WHERE c.deleted_at IS NULL AND (om.role IN ('OWNER','ADMIN') OR cm.user_id IS NOT NULL) ORDER BY c.name LIMIT 100`,
      [userId],
    )
  ).rows;
}
export async function createClient(
  userId: string,
  name: string,
  organizationId?: string,
) {
  return transaction(async (tx) => {
    let org = organizationId;
    if (!org) {
      const existing = await tx.query(
        "SELECT organization_id FROM organization_members WHERE user_id=$1 AND role IN ('OWNER','ADMIN') ORDER BY created_at LIMIT 1",
        [userId],
      );
      org = existing.rows[0]?.organization_id;
      if (!org) {
        org = (
          await tx.query(
            "INSERT INTO organizations(name) VALUES('G2A Marketing') RETURNING id",
          )
        ).rows[0].id;
        await tx.query(
          "INSERT INTO organization_members(organization_id,user_id,role) VALUES($1,$2,'OWNER')",
          [org, userId],
        );
      }
    }
    const access = await tx.query(
      "SELECT 1 FROM organization_members WHERE organization_id=$1 AND user_id=$2 AND role IN ('OWNER','ADMIN')",
      [org, userId],
    );
    if (!access.rowCount)
      throw new AppError(
        403,
        "FORBIDDEN",
        "Only an organization administrator can create clients.",
      );
    const client = (
      await tx.query(
        "INSERT INTO clients(organization_id,name) VALUES($1,$2) RETURNING *",
        [org, name],
      )
    ).rows[0];
    await tx.query(
      "INSERT INTO brand_profiles(organization_id,client_id,profile) VALUES($1,$2,$3)",
      [
        org,
        client.id,
        JSON.stringify({
          brandName: name,
          toneOfVoice: "Clear, helpful and professional",
          languages: "English, Hungarian",
        }),
      ],
    );
    await audit(
      tx,
      { userId, organizationId: org!, clientId: client.id, role: "OWNER" },
      "client.created",
      client.id,
    );
    return client;
  });
}
// Language of the client's external approval page and client-facing email.
export async function updateClientLocale(c: Context, locale: "hu" | "en") {
  return transaction(async (tx) => {
    await tx.query(
      "UPDATE clients SET locale=$1 WHERE organization_id=$2 AND id=$3",
      [locale, c.organizationId, c.clientId],
    );
    await audit(tx, c, "client.locale_updated", c.clientId, { locale });
    return { locale };
  });
}
export async function connectMock(
  c: Context,
  platform: Platform,
  name: string,
) {
  if ((process.env.SOCIAL_PROVIDER_MODE ?? "mock") !== "mock")
    throw new AppError(
      503,
      "APPROVAL_REQUIRED",
      "Live connections require configured, approved provider integration.",
    );
  return transaction(async (tx) => {
    const account = (
      await tx.query(
        "INSERT INTO social_accounts(organization_id,client_id,platform,name,remote_id,mode,capabilities,last_sync_at) VALUES($1,$2,$3,$4,$5,'mock',$6,now()) RETURNING *",
        [
          c.organizationId,
          c.clientId,
          platform,
          name,
          `mock-${crypto.randomUUID()}`,
          JSON.stringify(capabilities[platform]),
        ],
      )
    ).rows[0];
    await tx.query(
      "INSERT INTO social_credentials(organization_id,client_id,social_account_id,encrypted_value,expires_at) VALUES($1,$2,$3,$4,now()+interval '90 days')",
      [
        c.organizationId,
        c.clientId,
        account.id,
        encrypt(
          JSON.stringify({ mock: true }),
          `${c.organizationId}:${c.clientId}:${account.id}`,
        ),
      ],
    );
    await audit(tx, c, "social_account.connected", account.id, {
      platform,
      mode: "mock",
    });
    return account;
  });
}
export async function disconnect(c: Context, id: string) {
  const current = (
    await pool.query(
      "SELECT platform,mode FROM social_accounts WHERE organization_id=$1 AND client_id=$2 AND id=$3 AND deleted_at IS NULL",
      [c.organizationId, c.clientId, id],
    )
  ).rows[0];
  if (!current) throw new AppError(404, "NOT_FOUND", "Account not found.");
  if (
    current.mode === "direct" &&
    ["facebook", "instagram"].includes(current.platform)
  )
    return disconnectMeta(c, id);
  return transaction(async (tx) => {
    const account = (
      await tx.query(
        "SELECT * FROM social_accounts WHERE organization_id=$1 AND client_id=$2 AND id=$3 FOR UPDATE",
        [c.organizationId, c.clientId, id],
      )
    ).rows[0];
    if (!account) throw new AppError(404, "NOT_FOUND", "Account not found.");
    if (account.mode !== "mock")
      throw new AppError(
        409,
        "REVOCATION_REQUIRED",
        "Revoke the provider connection before removing credentials.",
      );
    await tx.query(
      "UPDATE social_accounts SET status='DISCONNECTED',token_health='REVOKED',updated_at=now() WHERE id=$1",
      [id],
    );
    await tx.query(
      `DELETE FROM analytics_sync_jobs
       WHERE social_account_id=$1 AND status<>'DONE'`,
      [id],
    );
    await tx.query(
      `DELETE FROM publish_reconciliation_jobs
       WHERE status IN ('PENDING','RETRY','RUNNING')
         AND publish_job_id IN (
           SELECT j.id FROM publish_jobs j
           JOIN post_targets t ON t.id=j.target_id
           WHERE t.social_account_id=$1
         )`,
      [id],
    );
    await tx.query(
      "DELETE FROM social_credentials WHERE social_account_id=$1",
      [id],
    );
    await tx.query(
      "INSERT INTO notifications(organization_id,client_id,message,resource_id) VALUES($1,$2,$3,$4)",
      [c.organizationId, c.clientId, `${account.name} was disconnected`, id],
    );
    await audit(tx, c, "social_account.disconnected", id);
  });
}
