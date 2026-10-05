import { auth } from "./auth";
import { db, sql } from "../db";
import { can, type Action, type Role } from "../core/domain";
import { AppError } from "../core/security";
export type Context = {
  userId: string;
  organizationId: string;
  clientId: string;
  role: Role;
};
export async function user(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) throw new AppError(401, "UNAUTHENTICATED", "Please sign in.");
  return session.user;
}
export async function context(
  request: Request,
  clientId: string,
  action: Action = "read",
): Promise<Context> {
  const actor = await user(request);
  const result = await db.execute(
    sql`SELECT c.organization_id, om.role AS org_role, cm.role AS client_role FROM clients c JOIN organizations o ON o.id=c.organization_id AND o.deleted_at IS NULL JOIN organization_members om ON om.organization_id=c.organization_id AND om.user_id=${actor.id} LEFT JOIN client_members cm ON cm.organization_id=c.organization_id AND cm.client_id=c.id AND cm.user_id=${actor.id} WHERE c.id=${clientId} AND c.deleted_at IS NULL`,
  );
  const row = result.rows[0];
  if (!row) throw new AppError(404, "NOT_FOUND", "Client not found.");
  const role = (
    ["OWNER", "ADMIN"].includes(String(row.org_role))
      ? row.org_role
      : row.client_role
  ) as Role;
  if (!role || !can(role, action))
    throw new AppError(
      403,
      "FORBIDDEN",
      "You do not have permission for this action.",
    );
  return {
    userId: actor.id,
    organizationId: String(row.organization_id),
    clientId,
    role,
  };
}
export function scope(c: Context) {
  return sql`organization_id=${c.organizationId} AND client_id=${c.clientId}`;
}
