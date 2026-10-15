import { pool } from "../db";
import type { Role } from "../core/domain";
import { AppError } from "../core/security";
import type { Context } from "./context";
import { sendMail } from "./mail";
import { accessRequestMail } from "./mail-templates";
import { inviteMember } from "./team";
import { audit, transaction } from "./transaction";

const emailList = (value: string | undefined) =>
  (value ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

// Platform operators review requests from people outside every organization.
export function isPlatformAdmin(email: string) {
  const admins = emailList(process.env.PLATFORM_ADMIN_EMAILS);
  return (
    admins.length ? admins : emailList(process.env.ACCESS_REQUEST_EMAIL)
  ).includes(email.trim().toLowerCase());
}

export function signUpMode(): "open" | "invite" {
  const mode = process.env.SIGNUP_MODE;
  if (mode === "open" || mode === "invite") return mode;
  return process.env.NODE_ENV === "production" ? "invite" : "open";
}

// In invite mode an account is created only for a pending invitation, or for
// a platform administrator bootstrapping the first organization.
export async function canCreateAccount(email: string) {
  if (signUpMode() === "open") return true;
  const normalized = email.trim().toLowerCase();
  if (isPlatformAdmin(normalized)) return true;
  const invitation = await pool.query(
    "SELECT 1 FROM member_invitations WHERE email=$1 AND status='PENDING' AND expires_at>now() LIMIT 1",
    [normalized],
  );
  return Boolean(invitation.rowCount);
}

// Known accounts always get their sign-in link; unknown addresses only when
// they could create an account, so strangers receive no dead-end email.
export async function shouldSendMagicLink(email: string) {
  const account = await pool.query(
    `SELECT 1 FROM "user" WHERE lower(email)=$1`,
    [email.trim().toLowerCase()],
  );
  return Boolean(account.rowCount) || canCreateAccount(email);
}

// The edge proxy (Railway, Vercel) sets x-real-ip from the connection; the
// first x-forwarded-for entry is client-supplied, so only the last one, added
// by the nearest proxy, is used as a fallback.
export function clientIp(request: Request) {
  const realIp = request.headers.get("x-real-ip")?.trim();
  if (realIp) return realIp;
  const forwarded = request.headers
    .get("x-forwarded-for")
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return forwarded?.at(-1) ?? "unknown";
}

async function operator(c: Context) {
  const person = (
    await pool.query(`SELECT email FROM "user" WHERE id=$1`, [c.userId])
  ).rows[0];
  if (
    !(["OWNER", "ADMIN"] as Role[]).includes(c.role) ||
    !person ||
    !isPlatformAdmin(person.email)
  )
    throw new AppError(
      403,
      "FORBIDDEN",
      "Only platform operators can review access requests.",
    );
}

async function notify(request: {
  id: string;
  name: string;
  email: string;
  company: string | null;
  message: string | null;
}) {
  const to = process.env.ACCESS_REQUEST_EMAIL;
  if (!to) {
    console.warn(
      JSON.stringify({
        event: "access_request_email_unconfigured",
        requestId: request.id,
      }),
    );
    return;
  }
  try {
    const mail = accessRequestMail("hu", {
      ...request,
      url: process.env.APP_URL ?? "",
    });
    await sendMail(to, mail.subject, mail.text);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "access_request_email_failed",
        requestId: request.id,
        errorName: error instanceof Error ? error.name : "Unknown",
      }),
    );
  }
}

export async function submitAccessRequest(input: {
  name: string;
  email: string;
  company?: string;
  message?: string;
  locale: "hu" | "en";
}) {
  const email = input.email.trim().toLowerCase();
  // Known accounts and repeated requests get the same answer, so the form
  // reveals nothing about who already has access.
  const account = await pool.query(
    `SELECT 1 FROM "user" WHERE lower(email)=$1`,
    [email],
  );
  if (account.rowCount) return { ok: true };
  const row = (
    await pool.query(
      `INSERT INTO access_requests(name,email,company,message,locale)
       VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING
       RETURNING id,name,email,company,message`,
      [
        input.name.trim(),
        email,
        input.company?.trim() || null,
        input.message?.trim() || null,
        input.locale,
      ],
    )
  ).rows[0];
  // The answer does not wait for SMTP either.
  if (row) void notify(row);
  return { ok: true };
}

export async function listAccessRequests(c: Context) {
  await operator(c);
  return (
    await pool.query(
      `SELECT id,name,email,company,message,locale,created_at
       FROM access_requests WHERE status='PENDING' ORDER BY created_at`,
    )
  ).rows;
}

async function pending(id: string) {
  const request = (
    await pool.query("SELECT email,status FROM access_requests WHERE id=$1", [
      id,
    ])
  ).rows[0];
  if (!request) throw new AppError(404, "NOT_FOUND", "Request not found.");
  if (request.status !== "PENDING")
    throw new AppError(
      409,
      "REQUEST_HANDLED",
      "This request has already been handled.",
    );
  return request as { email: string };
}

export async function approveAccessRequest(
  c: Context,
  id: string,
  role: Role,
  clientIds: string[],
) {
  await operator(c);
  const request = await pending(id);
  // A failed invitation leaves the request pending for another attempt.
  const invitation = await inviteMember(c, request.email, role, clientIds);
  await transaction(async (tx) => {
    const updated = await tx.query(
      `UPDATE access_requests SET status='APPROVED',handled_by=$2,handled_at=now(),
       organization_id=$3,invitation_id=$4,updated_at=now()
       WHERE id=$1 AND status='PENDING'`,
      [id, c.userId, c.organizationId, invitation.id],
    );
    if (!updated.rowCount)
      throw new AppError(
        409,
        "REQUEST_HANDLED",
        "This request has already been handled.",
      );
    await audit(tx, c, "access_request.approved", id, {
      role,
      invitationId: invitation.id,
    });
  });
  return invitation;
}

export async function rejectAccessRequest(c: Context, id: string) {
  await operator(c);
  await pending(id);
  return transaction(async (tx) => {
    const updated = await tx.query(
      `UPDATE access_requests SET status='REJECTED',handled_by=$2,handled_at=now(),updated_at=now()
       WHERE id=$1 AND status='PENDING'`,
      [id, c.userId],
    );
    if (!updated.rowCount)
      throw new AppError(
        409,
        "REQUEST_HANDLED",
        "This request has already been handled.",
      );
    await audit(tx, c, "access_request.rejected", id);
    return { ok: true };
  });
}
