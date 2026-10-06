import type { PoolClient } from "pg";
import { pool } from "../db";
import type { Role } from "../core/domain";
import { AppError, hashToken, token } from "../core/security";
import type { Context } from "./context";
import { sendMail } from "./mail";
import { invitationMail, userLocale } from "./mail-templates";
import { audit, transaction } from "./transaction";

const assignableRoles: Role[] = [
  "ADMIN",
  "SOCIAL_MANAGER",
  "CONTENT_CREATOR",
  "CLIENT_REVIEWER",
  "VIEWER",
];

function administrator(c: Context) {
  if (!(["OWNER", "ADMIN"] as Role[]).includes(c.role))
    throw new AppError(403, "FORBIDDEN", "Administrator access is required.");
}

async function validateAccess(
  tx: PoolClient,
  organizationId: string,
  role: Role,
  clientIds: string[],
) {
  if (!assignableRoles.includes(role))
    throw new AppError(422, "ROLE_INVALID", "Choose an assignable role.");
  const ids = [...new Set(clientIds)];
  if (role !== "ADMIN" && !ids.length)
    throw new AppError(
      422,
      "CLIENT_REQUIRED",
      "Choose at least one client for this role.",
    );
  if (ids.length) {
    const found = await tx.query(
      "SELECT id FROM clients WHERE organization_id=$1 AND id=ANY($2::uuid[]) AND deleted_at IS NULL",
      [organizationId, ids],
    );
    if (found.rowCount !== ids.length)
      throw new AppError(
        422,
        "CLIENT_INVALID",
        "A selected client is invalid.",
      );
  }
  return ids;
}

function canAssign(c: Context, role: Role) {
  if (role === "ADMIN" && c.role !== "OWNER")
    throw new AppError(
      403,
      "OWNER_REQUIRED",
      "Only an owner can grant administrator access.",
    );
}

export async function listTeam(c: Context) {
  administrator(c);
  const [members, invitations] = await Promise.all([
    pool.query(
      `SELECT u.id,u.name,u.email,om.role,om.created_at,
       coalesce(jsonb_agg(DISTINCT jsonb_build_object('id',cl.id,'name',cl.name))
       FILTER (WHERE cl.id IS NOT NULL),'[]'::jsonb) AS clients
       FROM organization_members om JOIN "user" u ON u.id=om.user_id
       LEFT JOIN client_members cm ON cm.organization_id=om.organization_id AND cm.user_id=om.user_id
       LEFT JOIN clients cl ON cl.organization_id=cm.organization_id AND cl.id=cm.client_id AND cl.deleted_at IS NULL
       WHERE om.organization_id=$1 GROUP BY u.id,u.name,u.email,om.role,om.created_at
       ORDER BY CASE om.role WHEN 'OWNER' THEN 0 WHEN 'ADMIN' THEN 1 ELSE 2 END,u.name`,
      [c.organizationId],
    ),
    pool.query(
      `SELECT mi.id,mi.email,mi.role,mi.status,mi.expires_at,mi.created_at,
       coalesce(jsonb_agg(DISTINCT jsonb_build_object('id',cl.id,'name',cl.name))
       FILTER (WHERE cl.id IS NOT NULL),'[]'::jsonb) AS clients
       FROM member_invitations mi
       LEFT JOIN member_invitation_clients mic ON mic.invitation_id=mi.id
       LEFT JOIN clients cl ON cl.id=mic.client_id AND cl.organization_id=mic.organization_id
       WHERE mi.organization_id=$1 AND mi.status='PENDING' AND mi.expires_at>now()
       GROUP BY mi.id ORDER BY mi.created_at DESC`,
      [c.organizationId],
    ),
  ]);
  return { members: members.rows, invitations: invitations.rows };
}

export async function inviteMember(
  c: Context,
  email: string,
  role: Role,
  clientIds: string[],
) {
  administrator(c);
  canAssign(c, role);
  const normalized = email.trim().toLowerCase();
  const secret = token();
  const invitation = await transaction(async (tx) => {
    const ids = await validateAccess(tx, c.organizationId, role, clientIds);
    const member = await tx.query(
      `SELECT 1 FROM organization_members om JOIN "user" u ON u.id=om.user_id
       WHERE om.organization_id=$1 AND lower(u.email)=$2`,
      [c.organizationId, normalized],
    );
    if (member.rowCount)
      throw new AppError(
        409,
        "ALREADY_MEMBER",
        "This user is already a member.",
      );
    await tx.query(
      "UPDATE member_invitations SET status='EXPIRED',updated_at=now() WHERE organization_id=$1 AND status='PENDING' AND expires_at<=now()",
      [c.organizationId],
    );
    const row = (
      await tx.query(
        `INSERT INTO member_invitations(organization_id,email,role,token_hash,invited_by,expires_at)
         VALUES($1,$2,$3,$4,$5,now()+interval '7 days') RETURNING id,email,role,status,expires_at`,
        [c.organizationId, normalized, role, hashToken(secret), c.userId],
      )
    ).rows[0];
    for (const clientId of role === "ADMIN" ? [] : ids)
      await tx.query(
        "INSERT INTO member_invitation_clients(organization_id,invitation_id,client_id) VALUES($1,$2,$3)",
        [c.organizationId, row.id, clientId],
      );
    await audit(tx, c, "team.invited", row.id, { email: normalized, role });
    return row;
  });
  const url = `${process.env.APP_URL}/invite/${secret}`;
  let emailDelivered = true;
  try {
    // The invitee has no account yet, so the inviter's language is used.
    const mail = invitationMail(await userLocale({ id: c.userId }), {
      role,
      url,
    });
    await sendMail(normalized, mail.subject, mail.text);
  } catch (error) {
    emailDelivered = false;
    console.error(
      JSON.stringify({
        event: "invitation_email_failed",
        invitationId: invitation.id,
        errorName: error instanceof Error ? error.name : "Unknown",
      }),
    );
  }
  return {
    ...invitation,
    emailDelivered,
    url: process.env.NODE_ENV === "production" ? undefined : url,
  };
}

export async function updateMember(
  c: Context,
  userId: string,
  role: Role,
  clientIds: string[],
) {
  administrator(c);
  if (userId === c.userId)
    throw new AppError(
      409,
      "SELF_CHANGE",
      "Another owner must change your access.",
    );
  canAssign(c, role);
  return transaction(async (tx) => {
    const target = (
      await tx.query(
        "SELECT role FROM organization_members WHERE organization_id=$1 AND user_id=$2 FOR UPDATE",
        [c.organizationId, userId],
      )
    ).rows[0];
    if (!target) throw new AppError(404, "NOT_FOUND", "Member not found.");
    if (target.role === "OWNER")
      throw new AppError(
        409,
        "OWNER_PROTECTED",
        "Owner access cannot be changed here.",
      );
    if (target.role === "ADMIN" && c.role !== "OWNER")
      throw new AppError(
        403,
        "OWNER_REQUIRED",
        "Only an owner can manage administrators.",
      );
    const ids = await validateAccess(tx, c.organizationId, role, clientIds);
    await tx.query(
      "UPDATE organization_members SET role=$3 WHERE organization_id=$1 AND user_id=$2",
      [c.organizationId, userId, role],
    );
    await tx.query(
      "DELETE FROM client_members WHERE organization_id=$1 AND user_id=$2",
      [c.organizationId, userId],
    );
    if (role !== "ADMIN")
      for (const clientId of ids)
        await tx.query(
          "INSERT INTO client_members(organization_id,client_id,user_id,role) VALUES($1,$2,$3,$4)",
          [c.organizationId, clientId, userId, role],
        );
    await audit(tx, c, "team.member_updated", userId, { role });
    return { ok: true };
  });
}

export async function removeMember(c: Context, userId: string) {
  administrator(c);
  if (userId === c.userId)
    throw new AppError(
      409,
      "SELF_REMOVE",
      "You cannot remove your own membership.",
    );
  return transaction(async (tx) => {
    const target = (
      await tx.query(
        "SELECT role FROM organization_members WHERE organization_id=$1 AND user_id=$2 FOR UPDATE",
        [c.organizationId, userId],
      )
    ).rows[0];
    if (!target) throw new AppError(404, "NOT_FOUND", "Member not found.");
    if (target.role === "OWNER")
      throw new AppError(
        409,
        "OWNER_PROTECTED",
        "The owner cannot be removed.",
      );
    if (target.role === "ADMIN" && c.role !== "OWNER")
      throw new AppError(
        403,
        "OWNER_REQUIRED",
        "Only an owner can remove administrators.",
      );
    await audit(tx, c, "team.member_removed", userId, { role: target.role });
    await tx.query(
      "DELETE FROM organization_members WHERE organization_id=$1 AND user_id=$2",
      [c.organizationId, userId],
    );
    return { ok: true };
  });
}

export async function revokeInvitation(c: Context, invitationId: string) {
  administrator(c);
  return transaction(async (tx) => {
    const invitation = (
      await tx.query(
        "SELECT role FROM member_invitations WHERE organization_id=$1 AND id=$2 AND status='PENDING' FOR UPDATE",
        [c.organizationId, invitationId],
      )
    ).rows[0];
    if (!invitation)
      throw new AppError(404, "NOT_FOUND", "Pending invitation not found.");
    if (invitation.role === "ADMIN" && c.role !== "OWNER")
      throw new AppError(
        403,
        "OWNER_REQUIRED",
        "Only an owner can revoke this invitation.",
      );
    await tx.query(
      "UPDATE member_invitations SET status='REVOKED',updated_at=now() WHERE id=$1",
      [invitationId],
    );
    await audit(tx, c, "team.invitation_revoked", invitationId);
    return { ok: true };
  });
}

export async function invitationView(secret: string) {
  const result = await pool.query(
    `SELECT mi.email,mi.role,mi.status,mi.expires_at,o.name AS organization_name,
     coalesce(jsonb_agg(jsonb_build_object('id',c.id,'name',c.name)) FILTER (WHERE c.id IS NOT NULL),'[]'::jsonb) AS clients
     FROM member_invitations mi JOIN organizations o ON o.id=mi.organization_id AND o.deleted_at IS NULL
     LEFT JOIN member_invitation_clients mic ON mic.invitation_id=mi.id
     LEFT JOIN clients c ON c.id=mic.client_id AND c.organization_id=mic.organization_id AND c.deleted_at IS NULL
     WHERE mi.token_hash=$1 GROUP BY mi.id,o.name`,
    [hashToken(secret)],
  );
  const row = result.rows[0];
  if (
    !row ||
    row.status !== "PENDING" ||
    new Date(row.expires_at) <= new Date()
  )
    throw new AppError(
      404,
      "INVITATION_INVALID",
      "This invitation is invalid or expired.",
    );
  return row;
}

export async function acceptInvitation(
  secret: string,
  actor: { id: string; email: string },
) {
  return transaction(async (tx) => {
    const invitation = (
      await tx.query(
        "SELECT * FROM member_invitations WHERE token_hash=$1 FOR UPDATE",
        [hashToken(secret)],
      )
    ).rows[0];
    if (
      !invitation ||
      invitation.status !== "PENDING" ||
      new Date(invitation.expires_at) <= new Date()
    )
      throw new AppError(
        404,
        "INVITATION_INVALID",
        "This invitation is invalid or expired.",
      );
    if (actor.email.trim().toLowerCase() !== invitation.email)
      throw new AppError(
        403,
        "EMAIL_MISMATCH",
        "Sign in with the invited email address.",
      );
    const existing = await tx.query(
      "SELECT 1 FROM organization_members WHERE organization_id=$1 AND user_id=$2",
      [invitation.organization_id, actor.id],
    );
    if (existing.rowCount)
      throw new AppError(
        409,
        "ALREADY_MEMBER",
        "This account is already a member.",
      );
    await tx.query(
      "INSERT INTO organization_members(organization_id,user_id,role) VALUES($1,$2,$3)",
      [invitation.organization_id, actor.id, invitation.role],
    );
    if (invitation.role !== "ADMIN")
      await tx.query(
        `INSERT INTO client_members(organization_id,client_id,user_id,role)
         SELECT organization_id,client_id,$2,$3 FROM member_invitation_clients WHERE invitation_id=$1`,
        [invitation.id, actor.id, invitation.role],
      );
    await tx.query(
      "UPDATE member_invitations SET status='ACCEPTED',accepted_at=now(),updated_at=now() WHERE id=$1",
      [invitation.id],
    );
    await tx.query(
      "INSERT INTO audit_logs(organization_id,actor_id,action,resource_id,metadata) VALUES($1,$2,'team.invitation_accepted',$3,$4)",
      [
        invitation.organization_id,
        actor.id,
        invitation.id,
        JSON.stringify({ role: invitation.role }),
      ],
    );
    return { ok: true };
  });
}
