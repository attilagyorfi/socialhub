import type { z } from "zod";
import { pool } from "../db";
import { can, permissions, type Role } from "../core/domain";
import { AppError } from "../core/security";
import type { Context } from "./context";
import { audit, transaction } from "./transaction";
import type { commentAssignInput } from "./validation";

export type Assignee = { id: string; name: string };

// Roles that may work on comments, and so can be given one.
export const assignableRoles = (Object.keys(permissions) as Role[]).filter(
  (role) => can(role, "create"),
);

// True when the user may work on the client's comments right now. Resolves
// the role like context(): OWNER/ADMIN in the organization, otherwise the
// client membership. The single definition for reading, filtering, counting
// and writing; `roles` is the placeholder of assignableRoles.
const assignable = (
  user: string,
  organization: string,
  client: string,
  roles: string,
) => `EXISTS(
  SELECT 1 FROM organization_members om
  LEFT JOIN client_members cm ON cm.organization_id=om.organization_id
    AND cm.client_id=${client} AND cm.user_id=om.user_id
  WHERE om.organization_id=${organization} AND om.user_id=${user}
    AND (CASE WHEN om.role IN ('OWNER','ADMIN') THEN om.role
              ELSE cm.role END)::text=ANY(${roles}::text[])
)`;

// Joins the assignment of social_comments "sc" as "ca" only while its member
// is assignable: a removed or demoted member's thread counts as unassigned.
export const assignmentJoin = (roles: string) =>
  `LEFT JOIN comment_assignments ca ON ca.organization_id=sc.organization_id
    AND ca.client_id=sc.client_id AND ca.comment_id=sc.id
    AND ${assignable("ca.user_id", "sc.organization_id", "sc.client_id", roles)}`;

// Names and ids only; e-mail addresses never leave the server here.
export async function assignableMembers(c: Context) {
  return (
    await pool.query(
      `SELECT u.id,u.name FROM "user" u
       WHERE ${assignable("u.id", "$1::uuid", "$2::uuid", "$3")}
       ORDER BY u.name,u.id`,
      [c.organizationId, c.clientId, assignableRoles],
    )
  ).rows as Assignee[];
}

export async function assignComment(
  c: Context,
  input: z.infer<typeof commentAssignInput>,
): Promise<{ assignee: Assignee | null }> {
  return transaction(async (tx) => {
    // Locking the comment first also serializes first-time assignments,
    // where there is no assignment row to lock yet.
    const comment = (
      await tx.query(
        `SELECT id,parent_remote_id,from_page FROM social_comments
         WHERE organization_id=$1 AND client_id=$2 AND id=$3 AND NOT deleted
         FOR UPDATE`,
        [c.organizationId, c.clientId, input.id],
      )
    ).rows[0];
    if (!comment) throw new AppError(404, "NOT_FOUND", "Comment not found.");
    if (comment.parent_remote_id !== null || comment.from_page)
      throw new AppError(
        422,
        "COMMENT_NOT_ASSIGNABLE",
        "Only comment threads can be assigned.",
      );
    let assignee: Assignee | null = null;
    if (input.assigneeId) {
      const member = (
        await tx.query(
          `SELECT u.id,u.name FROM "user" u WHERE u.id=$4
             AND ${assignable("u.id", "$1::uuid", "$2::uuid", "$3")}`,
          [c.organizationId, c.clientId, assignableRoles, input.assigneeId],
        )
      ).rows[0];
      // The same answer for unknown, foreign and unsuitable users.
      if (!member)
        throw new AppError(
          422,
          "ASSIGNEE_NOT_ALLOWED",
          "This person cannot be assigned to the comment.",
        );
      assignee = { id: member.id, name: member.name };
    }
    const current: string | null =
      (
        await tx.query(
          `SELECT ca.user_id FROM social_comments sc
           ${assignmentJoin("$2")} WHERE sc.id=$1`,
          [comment.id, assignableRoles],
        )
      ).rows[0]?.user_id ?? null;
    if (current !== input.expectedAssigneeId)
      throw new AppError(
        409,
        "COMMENT_ASSIGNMENT_CONFLICT",
        "Someone else has changed this assignment in the meantime.",
      );
    if (!assignee)
      // Also clears what a removed member left behind.
      await tx.query("DELETE FROM comment_assignments WHERE comment_id=$1", [
        comment.id,
      ]);
    if (current === (assignee?.id ?? null)) return { assignee };
    if (assignee)
      await tx.query(
        `INSERT INTO comment_assignments(
           comment_id,organization_id,client_id,user_id,assigned_by
         ) VALUES($1,$2,$3,$4,$5)
         ON CONFLICT(comment_id) DO UPDATE SET user_id=excluded.user_id,
           assigned_by=excluded.assigned_by,updated_at=now()`,
        [comment.id, c.organizationId, c.clientId, assignee.id, c.userId],
      );
    await audit(
      tx,
      c,
      assignee ? "comment.assigned" : "comment.unassigned",
      comment.id,
      {
        ...(assignee ? { assignedTo: assignee.id } : {}),
        ...(current ? { previousAssignee: current } : {}),
      },
    );
    return { assignee };
  });
}

// Roles without create rights never learn who works on a comment, so the
// assignment entries of the activity log reach them without the members.
export function visibleAuditRows<
  T extends { action: string; metadata: unknown },
>(role: Role, rows: T[]): T[] {
  if (can(role, "create")) return rows;
  return rows.map((row) =>
    row.action === "comment.assigned" || row.action === "comment.unassigned"
      ? { ...row, metadata: {} }
      : row,
  );
}
