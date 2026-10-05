import type { PoolClient } from "pg";
import type { Context } from "./context";
import { transaction, audit } from "./transaction";
import { AppError, token, hashToken } from "../core/security";
import { pool } from "../db";
export type ReviewKind = "INTERNAL" | "EXTERNAL";
export type ApprovalAutomationPolicy = {
  automaticReminders: boolean;
  firstReminderHours: number;
  repeatReminderHours: number;
  escalateAfterHours: number;
  maxAutomaticReminders: number;
};
export async function insertReview(
  tx: PoolClient,
  scope: {
    organization_id: string;
    client_id: string;
    post_id: string;
    revision: number;
    automatic_reminders?: boolean;
    first_reminder_hours?: number;
    repeat_reminder_hours?: number;
    escalate_after_hours?: number;
    max_automatic_reminders?: number;
  },
  steps: ReviewKind[],
  assignedTo?: string | null,
) {
  if (steps[0] === "INTERNAL" && !assignedTo)
    throw new AppError(
      422,
      "REVIEWER_REQUIRED",
      "Choose an internal reviewer.",
    );
  const secret = token();
  const storedPolicy =
    scope.automatic_reminders === undefined
      ? (
          await tx.query(
            `SELECT automatic_reminders,first_reminder_hours,repeat_reminder_hours,
                    escalate_after_hours,max_automatic_reminders
             FROM approval_workflows
             WHERE organization_id=$1 AND client_id=$2 AND is_default`,
            [scope.organization_id, scope.client_id],
          )
        ).rows[0]
      : null;
  const automaticReminders =
    scope.automatic_reminders ?? storedPolicy?.automatic_reminders ?? false;
  const firstReminderHours =
    scope.first_reminder_hours ?? storedPolicy?.first_reminder_hours ?? 24;
  const repeatReminderHours =
    scope.repeat_reminder_hours ?? storedPolicy?.repeat_reminder_hours ?? 24;
  const maxAutomaticReminders =
    scope.max_automatic_reminders ?? storedPolicy?.max_automatic_reminders ?? 2;
  const escalateAfterHours =
    scope.escalate_after_hours ?? storedPolicy?.escalate_after_hours ?? 72;
  await tx.query(
    `INSERT INTO approval_requests(
       organization_id,client_id,post_id,revision,token_hash,expires_at,step_kind,
       remaining_steps,assigned_to,automatic_reminders,first_reminder_hours,
       repeat_reminder_hours,escalate_after_hours,max_automatic_reminders,
       next_reminder_at,escalation_at
     ) VALUES(
       $1,$2,$3,$4,$5,now()+interval '7 days',$6,$7,$8,$9,$10,$11,$12,$13,
       CASE WHEN $9 AND $6='INTERNAL' AND $13>0
         THEN now()+make_interval(hours => $10) END,
       CASE WHEN $9 THEN now()+make_interval(hours => $12) END
     )`,
    [
      scope.organization_id,
      scope.client_id,
      scope.post_id,
      scope.revision,
      hashToken(secret),
      steps[0],
      JSON.stringify(steps.slice(1)),
      steps[0] === "INTERNAL" ? assignedTo : null,
      automaticReminders,
      firstReminderHours,
      repeatReminderHours,
      escalateAfterHours,
      maxAutomaticReminders,
    ],
  );
  return {
    url:
      steps[0] === "EXTERNAL"
        ? `${process.env.APP_URL}/approve/${secret}`
        : null,
    kind: steps[0],
  };
}
export async function reviewerCandidates(c: Context) {
  return (
    await pool.query(
      `SELECT u.id,u.name,
       CASE WHEN om.role IN ('OWNER','ADMIN') THEN om.role ELSE cm.role END AS role
       FROM organization_members om
       JOIN "user" u ON u.id=om.user_id
       LEFT JOIN client_members cm ON cm.organization_id=om.organization_id
         AND cm.client_id=$2 AND cm.user_id=om.user_id
       WHERE om.organization_id=$1 AND (
         om.role IN ('OWNER','ADMIN')
         OR cm.role IN ('SOCIAL_MANAGER','CLIENT_REVIEWER')
       )
       ORDER BY u.name,u.id`,
      [c.organizationId, c.clientId],
    )
  ).rows;
}
export async function validateReviewer(
  tx: PoolClient,
  c: Context,
  reviewerId: string,
) {
  const reviewer = (
    await tx.query(
      `SELECT u.id,u.name,u.email,
       CASE WHEN om.role IN ('OWNER','ADMIN') THEN om.role ELSE cm.role END AS role
       FROM organization_members om
       JOIN "user" u ON u.id=om.user_id
       LEFT JOIN client_members cm ON cm.organization_id=om.organization_id
         AND cm.client_id=$2 AND cm.user_id=om.user_id
       WHERE om.organization_id=$1 AND u.id=$3 AND (
         om.role IN ('OWNER','ADMIN')
         OR cm.role IN ('SOCIAL_MANAGER','CLIENT_REVIEWER')
       )`,
      [c.organizationId, c.clientId, reviewerId],
    )
  ).rows[0];
  if (!reviewer)
    throw new AppError(
      422,
      "INVALID_REVIEWER",
      "Choose a reviewer with approval access to this client.",
    );
  return reviewer;
}
export async function workflowSteps(tx: PoolClient, c: Context) {
  const steps = (
    await tx.query(
      "SELECT s.kind FROM approval_steps s JOIN approval_workflows w ON w.id=s.workflow_id WHERE w.organization_id=$1 AND w.client_id=$2 AND w.is_default ORDER BY s.position",
      [c.organizationId, c.clientId],
    )
  ).rows.map((r) => r.kind as ReviewKind);
  return steps.length ? steps : (["EXTERNAL"] as ReviewKind[]);
}
export async function saveWorkflow(
  c: Context,
  steps: ReviewKind[],
  automation?: ApprovalAutomationPolicy,
) {
  if (
    !steps.length ||
    steps.length > 2 ||
    new Set(steps).size !== steps.length ||
    (steps.length === 2 && steps[0] !== "INTERNAL")
  )
    throw new AppError(
      422,
      "INVALID_WORKFLOW",
      "Choose internal review, client review, or internal followed by client review.",
    );
  return transaction(async (tx) => {
    await tx.query("SELECT id FROM clients WHERE id=$1 FOR UPDATE", [
      c.clientId,
    ]);
    let workflow = (
      await tx.query(
        `SELECT id,automatic_reminders,first_reminder_hours,repeat_reminder_hours,
                escalate_after_hours,max_automatic_reminders
         FROM approval_workflows
         WHERE organization_id=$1 AND client_id=$2 AND is_default`,
        [c.organizationId, c.clientId],
      )
    ).rows[0];
    if (!workflow)
      workflow = (
        await tx.query(
          `INSERT INTO approval_workflows(organization_id,client_id,name)
           VALUES($1,$2,'Client approval policy')
           RETURNING id,automatic_reminders,first_reminder_hours,
                     repeat_reminder_hours,escalate_after_hours,
                     max_automatic_reminders`,
          [c.organizationId, c.clientId],
        )
      ).rows[0];
    const resolvedAutomation =
      automation ??
      ({
        automaticReminders: workflow.automatic_reminders,
        firstReminderHours: workflow.first_reminder_hours,
        repeatReminderHours: workflow.repeat_reminder_hours,
        escalateAfterHours: workflow.escalate_after_hours,
        maxAutomaticReminders: workflow.max_automatic_reminders,
      } satisfies ApprovalAutomationPolicy);
    await tx.query(
      `UPDATE approval_workflows SET automatic_reminders=$1,first_reminder_hours=$2,
         repeat_reminder_hours=$3,escalate_after_hours=$4,max_automatic_reminders=$5,
         updated_at=now() WHERE id=$6`,
      [
        resolvedAutomation.automaticReminders,
        resolvedAutomation.firstReminderHours,
        resolvedAutomation.repeatReminderHours,
        resolvedAutomation.escalateAfterHours,
        resolvedAutomation.maxAutomaticReminders,
        workflow.id,
      ],
    );
    await tx.query("DELETE FROM approval_steps WHERE workflow_id=$1", [
      workflow.id,
    ]);
    for (let i = 0; i < steps.length; i++)
      await tx.query(
        "INSERT INTO approval_steps(organization_id,client_id,workflow_id,position,kind) VALUES($1,$2,$3,$4,$5)",
        [c.organizationId, c.clientId, workflow.id, i + 1, steps[i]],
      );
    await audit(tx, c, "approval.workflow_updated", workflow.id, {
      steps,
      automation: resolvedAutomation,
    });
    return { steps, automation: resolvedAutomation };
  });
}
export async function rotateReviewLink(c: Context, id: string) {
  return transaction(async (tx) => {
    const request = (
      await tx.query(
        "SELECT ar.* FROM approval_requests ar JOIN posts p ON p.id=ar.post_id AND p.revision=ar.revision WHERE ar.organization_id=$1 AND ar.client_id=$2 AND ar.post_id=$3 AND ar.step_kind='EXTERNAL' AND ar.status='PENDING' AND p.status='PENDING_APPROVAL' FOR UPDATE OF ar",
        [c.organizationId, c.clientId, id],
      )
    ).rows[0];
    if (!request)
      throw new AppError(
        409,
        "NO_CLIENT_REVIEW",
        "No client review is waiting for this post.",
      );
    const secret = token();
    await tx.query(
      "UPDATE approval_requests SET token_hash=$1,expires_at=now()+interval '7 days',updated_at=now() WHERE id=$2",
      [hashToken(secret), request.id],
    );
    await audit(tx, c, "approval.link_rotated", id);
    return { url: `${process.env.APP_URL}/approve/${secret}` };
  });
}
