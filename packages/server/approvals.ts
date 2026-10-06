import type { Context } from "./context";
import { transaction, audit } from "./transaction";
import { AppError, hashToken } from "../core/security";
import { pool } from "../db";
import { mediaUrl } from "./media";
import {
  assertNotSelfReview,
  insertReview,
  validateReviewer,
  workflowSteps,
  type ReviewKind,
} from "./approval-workflows";
import { sendMail } from "./mail";
import {
  escalationMail,
  reviewReminderMail,
  userLocale,
} from "./mail-templates";
import { checkBrandGuardrails } from "../core/brand-guardrails";
import { publishabilityErrors } from "./posts";
import type { Platform } from "../core/domain";
export async function requestApproval(
  c: Context,
  id: string,
  reviewerId?: string,
) {
  return transaction(async (tx) => {
    const post = (
      await tx.query(
        "SELECT * FROM posts WHERE organization_id=$1 AND client_id=$2 AND id=$3 FOR UPDATE",
        [c.organizationId, c.clientId, id],
      )
    ).rows[0];
    if (!post) throw new AppError(404, "NOT_FOUND", "Post not found.");
    if (post.status !== "DRAFT")
      throw new AppError(
        409,
        "INVALID_STATE",
        "Only drafts can be submitted for approval.",
      );
    const brand =
      (
        await tx.query(
          "SELECT profile FROM brand_profiles WHERE organization_id=$1 AND client_id=$2",
          [c.organizationId, c.clientId],
        )
      ).rows[0]?.profile ?? {};
    const targets = (
      await tx.query(
        `SELECT pt.caption,sa.platform
         FROM post_targets pt
         JOIN social_accounts sa ON sa.id=pt.social_account_id
         WHERE pt.organization_id=$1 AND pt.client_id=$2 AND pt.post_id=$3`,
        [c.organizationId, c.clientId, id],
      )
    ).rows as { caption: string; platform: Platform }[];
    const blocking = targets.flatMap((target) =>
      checkBrandGuardrails(target.caption, brand, [
        target.platform,
      ]).issues.filter((issue) => issue.severity === "BLOCK"),
    );
    const { errors: publishErrors } = await publishabilityErrors(tx, c, post);
    if (publishErrors.length)
      throw new AppError(
        422,
        "VALIDATION",
        `This post cannot be published as it is. ${publishErrors.join(" ")}`,
      );
    if (blocking.length)
      throw new AppError(
        422,
        "BRAND_GUARDRAIL",
        `Brand review blocked approval: ${blocking[0].message}${blocking.length > 1 ? ` (+${blocking.length - 1} more)` : ""}`,
      );
    const steps = await workflowSteps(tx, c);
    const reviewer =
      steps[0] === "INTERNAL"
        ? await validateReviewer(tx, c, reviewerId ?? c.userId, post.author_id)
        : undefined;
    const next = await insertReview(
      tx,
      { ...post, post_id: id },
      steps,
      reviewer?.id,
    );
    await tx.query(
      "UPDATE posts SET status='PENDING_APPROVAL',updated_at=now() WHERE id=$1",
      [id],
    );
    await tx.query(
      "INSERT INTO notifications(organization_id,client_id,message,resource_id) VALUES($1,$2,$3,$4)",
      [c.organizationId, c.clientId, "A post is awaiting approval", id],
    );
    await audit(tx, c, "post.submitted", id, {
      reviewKind: steps[0],
      assignedTo: reviewer?.id,
    });
    return next;
  });
}
export async function expireDueApprovals(scope?: {
  organizationId: string;
  clientId: string;
}) {
  return transaction(async (tx) => {
    const values: string[] = [];
    const scoped = scope
      ? " AND ar.organization_id=$1 AND ar.client_id=$2"
      : "";
    if (scope) values.push(scope.organizationId, scope.clientId);
    const expired = (
      await tx.query(
        `UPDATE approval_requests ar SET status='EXPIRED',updated_at=now()
         FROM posts p
         WHERE p.id=ar.post_id AND p.revision=ar.revision
           AND p.status='PENDING_APPROVAL'
           AND ar.status='PENDING' AND ar.expires_at<=now()${scoped}
         RETURNING ar.organization_id,ar.client_id,ar.post_id,ar.id,ar.revision`,
        values,
      )
    ).rows;
    for (const request of expired) {
      await tx.query(
        `INSERT INTO audit_logs(
           organization_id,client_id,action,resource_id,metadata
         ) VALUES($1,$2,'approval.expired',$3,$4)`,
        [
          request.organization_id,
          request.client_id,
          request.post_id,
          JSON.stringify({
            approvalRequestId: request.id,
            revision: request.revision,
          }),
        ],
      );
      await tx.query(
        "INSERT INTO notifications(organization_id,client_id,message,resource_id) VALUES($1,$2,$3,$4)",
        [
          request.organization_id,
          request.client_id,
          "An approval request expired",
          request.post_id,
        ],
      );
    }
    return expired.length;
  });
}

export async function processApprovalAutomations(limit = 50) {
  await pool.query(
    `UPDATE approval_automation_deliveries d
     SET status='CANCELLED',error_code='REVIEW_NO_LONGER_PENDING',updated_at=now()
     FROM approval_requests ar
     JOIN posts p ON p.id=ar.post_id
     WHERE d.approval_request_id=ar.id AND d.status IN ('PENDING','FAILED')
       AND (ar.status<>'PENDING' OR p.status<>'PENDING_APPROVAL' OR p.revision<>ar.revision)`,
  );
  const queued = await transaction(async (tx) => {
    const deliveries: string[] = [];
    const reminders = (
      await tx.query(
        `SELECT ar.*,u.id AS recipient_user_id,u.email AS recipient_email
         FROM approval_requests ar
         JOIN posts p ON p.id=ar.post_id AND p.revision=ar.revision
         JOIN "user" u ON u.id=ar.assigned_to
         WHERE ar.status='PENDING' AND p.status='PENDING_APPROVAL'
           AND ar.automatic_reminders AND ar.step_kind='INTERNAL'
           AND ar.next_reminder_at<=now()
           AND ar.automatic_reminder_count<ar.max_automatic_reminders
         ORDER BY ar.next_reminder_at,ar.id LIMIT $1
         FOR UPDATE OF ar SKIP LOCKED`,
        [Math.max(1, Math.min(200, limit))],
      )
    ).rows;
    for (const request of reminders) {
      const sequence = request.automatic_reminder_count + 1;
      const delivery = (
        await tx.query(
          `INSERT INTO approval_automation_deliveries(
             organization_id,client_id,approval_request_id,kind,sequence,
             recipient_user_id,recipient_email
           ) VALUES($1,$2,$3,'REMINDER',$4,$5,$6)
           ON CONFLICT DO NOTHING RETURNING id`,
          [
            request.organization_id,
            request.client_id,
            request.id,
            sequence,
            request.recipient_user_id,
            request.recipient_email,
          ],
        )
      ).rows[0];
      if (!delivery) continue;
      deliveries.push(delivery.id);
      await tx.query(
        `UPDATE approval_requests SET
           automatic_reminder_count=automatic_reminder_count+1,
           reminder_count=reminder_count+1,reminder_sent_at=now(),
           next_reminder_at=CASE
             WHEN automatic_reminder_count+1<max_automatic_reminders
             THEN now()+make_interval(hours => repeat_reminder_hours)
           END,updated_at=now()
         WHERE id=$1`,
        [request.id],
      );
      await tx.query(
        `INSERT INTO audit_logs(
           organization_id,client_id,action,resource_id,metadata
         ) VALUES($1,$2,'approval.automatic_reminder_queued',$3,$4)`,
        [
          request.organization_id,
          request.client_id,
          request.post_id,
          JSON.stringify({
            approvalRequestId: request.id,
            sequence,
            assignedTo: request.assigned_to,
          }),
        ],
      );
    }

    const escalations = (
      await tx.query(
        `SELECT ar.* FROM approval_requests ar
         JOIN posts p ON p.id=ar.post_id AND p.revision=ar.revision
         WHERE ar.status='PENDING' AND p.status='PENDING_APPROVAL'
           AND ar.automatic_reminders AND ar.escalation_at<=now()
           AND ar.escalated_at IS NULL
         ORDER BY ar.escalation_at,ar.id LIMIT $1
         FOR UPDATE OF ar SKIP LOCKED`,
        [Math.max(1, Math.min(200, limit))],
      )
    ).rows;
    for (const request of escalations) {
      const recipients = (
        await tx.query(
          `SELECT u.id,u.email FROM organization_members om
           JOIN "user" u ON u.id=om.user_id
           WHERE om.organization_id=$1 AND om.role IN ('OWNER','ADMIN')
           ORDER BY u.id`,
          [request.organization_id],
        )
      ).rows;
      for (const recipient of recipients) {
        const delivery = (
          await tx.query(
            `INSERT INTO approval_automation_deliveries(
               organization_id,client_id,approval_request_id,kind,sequence,
               recipient_user_id,recipient_email
             ) VALUES($1,$2,$3,'ESCALATION',1,$4,$5)
             ON CONFLICT DO NOTHING RETURNING id`,
            [
              request.organization_id,
              request.client_id,
              request.id,
              recipient.id,
              recipient.email,
            ],
          )
        ).rows[0];
        if (delivery) deliveries.push(delivery.id);
      }
      await tx.query(
        "UPDATE approval_requests SET escalated_at=now(),updated_at=now() WHERE id=$1",
        [request.id],
      );
      await tx.query(
        `INSERT INTO notifications(organization_id,client_id,message,resource_id)
         VALUES($1,$2,$3,$4)`,
        [
          request.organization_id,
          request.client_id,
          "Approval review is overdue and was escalated",
          request.post_id,
        ],
      );
      await tx.query(
        `INSERT INTO audit_logs(
           organization_id,client_id,action,resource_id,metadata
         ) VALUES($1,$2,'approval.escalation_queued',$3,$4)`,
        [
          request.organization_id,
          request.client_id,
          request.post_id,
          JSON.stringify({
            approvalRequestId: request.id,
            reviewKind: request.step_kind,
            recipientCount: recipients.length,
          }),
        ],
      );
    }
    return deliveries;
  });

  await pool.query(
    `UPDATE approval_automation_deliveries SET status='FAILED',
       error_code='DELIVERY_INTERRUPTED',run_at=now(),updated_at=now()
     WHERE status='SENDING' AND updated_at<now()-interval '10 minutes'`,
  );
  let sent = 0;
  let failed = 0;
  for (let i = 0; i < Math.max(1, Math.min(200, limit)); i++) {
    const delivery = await transaction(async (tx) => {
      const row = (
        await tx.query(
          `SELECT d.*,ar.post_id,ar.step_kind,ar.expires_at,p.caption,
                  c.name AS client_name,o.timezone,u.name AS reviewer_name
           FROM approval_automation_deliveries d
           JOIN approval_requests ar ON ar.id=d.approval_request_id
           JOIN posts p ON p.id=ar.post_id
           JOIN clients c ON c.id=ar.client_id
           JOIN organizations o ON o.id=ar.organization_id
           LEFT JOIN "user" u ON u.id=ar.assigned_to
           WHERE d.status IN ('PENDING','FAILED') AND d.attempts<3
             AND d.run_at<=now()
             AND ar.status='PENDING' AND p.status='PENDING_APPROVAL'
             AND p.revision=ar.revision
           ORDER BY d.run_at,d.created_at LIMIT 1
           FOR UPDATE OF d SKIP LOCKED`,
        )
      ).rows[0];
      if (!row) return null;
      await tx.query(
        `UPDATE approval_automation_deliveries
         SET status='SENDING',attempts=attempts+1,error_code=NULL,updated_at=now()
         WHERE id=$1`,
        [row.id],
      );
      return { ...row, attempts: row.attempts + 1 };
    });
    if (!delivery) break;
    try {
      const reminder = delivery.kind === "REMINDER";
      const locale = await userLocale({ email: delivery.recipient_email });
      const mail = reminder
        ? reviewReminderMail(locale, {
            reviewerName: delivery.reviewer_name,
            clientName: delivery.client_name,
            caption: delivery.caption,
            expiresAt: delivery.expires_at,
            timeZone: delivery.timezone,
            automatic: true,
          })
        : escalationMail(locale, {
            stepKind: String(delivery.step_kind),
            clientName: delivery.client_name,
            caption: delivery.caption,
          });
      await sendMail(delivery.recipient_email, mail.subject, mail.text);
      await transaction(async (tx) => {
        await tx.query(
          `UPDATE approval_automation_deliveries
           SET status='SENT',sent_at=now(),updated_at=now() WHERE id=$1`,
          [delivery.id],
        );
        await tx.query(
          `INSERT INTO audit_logs(
             organization_id,client_id,action,resource_id,metadata
           ) VALUES($1,$2,$3,$4,$5)`,
          [
            delivery.organization_id,
            delivery.client_id,
            reminder
              ? "approval.automatic_reminder_sent"
              : "approval.escalation_sent",
            delivery.post_id,
            JSON.stringify({
              approvalRequestId: delivery.approval_request_id,
              deliveryId: delivery.id,
              sequence: delivery.sequence,
            }),
          ],
        );
      });
      sent++;
    } catch (error) {
      await pool.query(
        `UPDATE approval_automation_deliveries SET status='FAILED',
           error_code='EMAIL_DELIVERY_FAILED',
           run_at=now()+make_interval(mins => power(2,least(attempts,6))::integer),
           updated_at=now() WHERE id=$1`,
        [delivery.id],
      );
      console.error(
        JSON.stringify({
          event: "approval_automation_email_failed",
          deliveryId: delivery.id,
          errorName: error instanceof Error ? error.name : "Unknown",
        }),
      );
      failed++;
    }
  }
  return { queued: queued.length, sent, failed };
}
export async function approvalView(secret: string) {
  const result = await pool.query(
    `SELECT ar.id,ar.organization_id,ar.client_id,ar.status,ar.expires_at,
            p.caption,p.link,p.scheduled_at,c.name AS client_name,c.locale,o.timezone,v.snapshot
     FROM approval_requests ar
     JOIN posts p ON p.id=ar.post_id AND p.revision=ar.revision
     JOIN clients c ON c.id=ar.client_id AND c.deleted_at IS NULL
     JOIN organizations o ON o.id=c.organization_id AND o.deleted_at IS NULL
     JOIN post_versions v ON v.post_id=p.id AND v.revision=ar.revision
     WHERE ar.token_hash=$1 AND ar.step_kind='EXTERNAL' AND ar.expires_at>now()`,
    [hashToken(secret)],
  );
  const request = result.rows[0];
  if (!request)
    throw new AppError(
      404,
      "EXPIRED",
      "This approval link is invalid or expired.",
    );
  const c: Context = {
    organizationId: request.organization_id,
    clientId: request.client_id,
    userId: "",
    role: "CLIENT_REVIEWER",
  };
  const versions = await Promise.all(
    request.snapshot.targets.map(
      async (target: {
        accountId: string;
        caption: string;
        mediaIds: string[];
      }) => {
        const account = (
          await pool.query(
            "SELECT platform,name FROM social_accounts WHERE id=$1 AND organization_id=$2 AND client_id=$3",
            [target.accountId, c.organizationId, c.clientId],
          )
        ).rows[0];
        const assets = (
          await pool.query(
            "SELECT id,name,mime_type FROM media_assets WHERE organization_id=$1 AND client_id=$2 AND id=ANY($3::uuid[]) AND deleted_at IS NULL",
            [c.organizationId, c.clientId, target.mediaIds],
          )
        ).rows;
        return {
          platform: account?.platform,
          name: account?.name,
          caption: target.caption,
          media: await Promise.all(
            assets.map(async (a) => ({ ...a, url: await mediaUrl(c, a.id) })),
          ),
        };
      },
    ),
  );
  const comments = (
    await pool.query(
      "SELECT author,body,created_at FROM approval_comments WHERE approval_request_id=$1 ORDER BY created_at LIMIT 100",
      [request.id],
    )
  ).rows;
  return {
    status: request.status,
    expires_at: request.expires_at,
    caption: request.caption,
    link: request.link,
    scheduled_at: request.scheduled_at,
    client_name: request.client_name,
    locale: request.locale,
    timezone: request.timezone,
    versions,
    comments,
  };
}
export async function decideApproval(
  secret: string,
  action: "approve" | "changes" | "comment",
  comment: string,
  actor?: Context,
) {
  if (
    actor &&
    !["OWNER", "ADMIN", "SOCIAL_MANAGER", "CLIENT_REVIEWER"].includes(
      actor.role,
    )
  )
    throw new AppError(
      403,
      "FORBIDDEN",
      "An internal agency reviewer is required.",
    );
  return transaction(async (tx) => {
    const request = (
      await tx.query(
        actor
          ? "SELECT * FROM approval_requests WHERE post_id=$1 AND organization_id=$2 AND client_id=$3 AND step_kind='INTERNAL' AND status='PENDING' AND expires_at>now() FOR UPDATE"
          : // Same visibility rules as approvalView: no decisions for deleted tenants.
            `SELECT ar.* FROM approval_requests ar
             JOIN clients c ON c.id=ar.client_id AND c.deleted_at IS NULL
             JOIN organizations o ON o.id=c.organization_id AND o.deleted_at IS NULL
             WHERE ar.token_hash=$1 AND ar.step_kind='EXTERNAL' AND ar.expires_at>now()
             FOR UPDATE OF ar`,
        actor
          ? [secret, actor.organizationId, actor.clientId]
          : [hashToken(secret)],
      )
    ).rows[0];
    if (!request)
      throw new AppError(
        404,
        "EXPIRED",
        "This approval link is invalid or expired.",
      );
    if (actor && request.assigned_to && request.assigned_to !== actor.userId)
      throw new AppError(
        403,
        "ASSIGNEE_REQUIRED",
        "This review is assigned to another reviewer.",
      );
    const post = (
      await tx.query("SELECT * FROM posts WHERE id=$1 FOR UPDATE", [
        request.post_id,
      ])
    ).rows[0];
    if (
      request.status !== "PENDING" ||
      post.status !== "PENDING_APPROVAL" ||
      request.revision !== post.revision
    )
      throw new AppError(
        409,
        "STALE_APPROVAL",
        "This request has already been decided or the post has changed.",
      );
    if (actor && action !== "comment")
      await assertNotSelfReview(tx, actor, actor.userId, post.author_id);
    if (action !== "approve" && !comment.trim())
      throw new AppError(
        422,
        "COMMENT_REQUIRED",
        "Please explain the requested changes or enter a comment.",
      );
    if (comment.trim())
      await tx.query(
        `INSERT INTO approval_comments(
           organization_id,client_id,approval_request_id,author,body,author_user_id
         ) VALUES($1,$2,$3,$4,$5,$6)`,
        [
          request.organization_id,
          request.client_id,
          request.id,
          actor ? "Internal reviewer" : "External reviewer",
          comment,
          actor?.userId ?? null,
        ],
      );
    let next: { url: string | null; kind: string } | undefined;
    if (action !== "comment") {
      await tx.query(
        "UPDATE approval_requests SET status=$1,updated_at=now() WHERE id=$2",
        [action === "approve" ? "APPROVED" : "CHANGES_REQUESTED", request.id],
      );
      if (action === "approve" && request.remaining_steps.length)
        next = await insertReview(tx, request, request.remaining_steps);
      await tx.query(
        "UPDATE posts SET status=$1,updated_at=now() WHERE id=$2",
        [
          action === "approve"
            ? next
              ? "PENDING_APPROVAL"
              : "APPROVED"
            : "DRAFT",
          post.id,
        ],
      );
    }
    await tx.query(
      "INSERT INTO audit_logs(organization_id,client_id,action,resource_id,metadata,actor_id) VALUES($1,$2,$3,$4,$5,$6)",
      [
        request.organization_id,
        request.client_id,
        `approval.${action}`,
        post.id,
        JSON.stringify({
          actor: actor?.userId ?? "external-reviewer",
          approvalRequestId: request.id,
          revision: request.revision,
        }),
        actor?.userId ?? null,
      ],
    );
    await tx.query(
      "INSERT INTO notifications(organization_id,client_id,message,resource_id) VALUES($1,$2,$3,$4)",
      [
        request.organization_id,
        request.client_id,
        next
          ? "Internal approval complete; client approval is required"
          : action === "approve"
            ? "Post approved"
            : action === "changes"
              ? "Changes requested"
              : "Reviewer commented",
        post.id,
      ],
    );
    return {
      status:
        action === "approve"
          ? next
            ? "PENDING_APPROVAL"
            : "APPROVED"
          : action === "changes"
            ? "CHANGES_REQUESTED"
            : "PENDING",
      url: next?.url,
    };
  });
}

function requireReviewManager(c: Context, message: string) {
  if (!["OWNER", "ADMIN", "SOCIAL_MANAGER"].includes(c.role))
    throw new AppError(403, "FORBIDDEN", message);
}

export async function assignApprovalReviewer(
  c: Context,
  postId: string,
  reviewerId: string,
) {
  requireReviewManager(
    c,
    "A social manager or administrator must assign reviewers.",
  );
  return transaction(async (tx) => {
    const request = (
      await tx.query(
        `SELECT ar.*,p.author_id FROM approval_requests ar
         JOIN posts p ON p.id=ar.post_id AND p.revision=ar.revision
         WHERE ar.organization_id=$1 AND ar.client_id=$2 AND ar.post_id=$3
           AND ar.step_kind='INTERNAL' AND ar.status='PENDING'
           AND ar.expires_at>now() AND p.status='PENDING_APPROVAL'
         ORDER BY ar.created_at DESC,ar.id DESC LIMIT 1 FOR UPDATE OF ar`,
        [c.organizationId, c.clientId, postId],
      )
    ).rows[0];
    if (!request)
      throw new AppError(
        409,
        "NO_INTERNAL_REVIEW",
        "No active internal review is waiting for this post.",
      );
    const reviewer = await validateReviewer(
      tx,
      c,
      reviewerId,
      request.author_id,
    );
    await tx.query(
      `UPDATE approval_requests SET assigned_to=$1,reminder_sent_at=NULL,
         next_reminder_at=CASE
           WHEN automatic_reminders AND automatic_reminder_count<max_automatic_reminders
           THEN now()+make_interval(hours => repeat_reminder_hours) END,
         updated_at=now() WHERE id=$2`,
      [reviewer.id, request.id],
    );
    await tx.query(
      `UPDATE approval_automation_deliveries
       SET status='CANCELLED',error_code='REVIEW_REASSIGNED',updated_at=now()
       WHERE approval_request_id=$1 AND status IN ('PENDING','FAILED')`,
      [request.id],
    );
    await audit(tx, c, "approval.reassigned", postId, {
      approvalRequestId: request.id,
      previousAssignee: request.assigned_to,
      assignedTo: reviewer.id,
    });
    await tx.query(
      "INSERT INTO notifications(organization_id,client_id,message,resource_id) VALUES($1,$2,$3,$4)",
      [
        c.organizationId,
        c.clientId,
        `Internal review assigned to ${reviewer.name}`,
        postId,
      ],
    );
    return { assignedTo: reviewer.id, reviewerName: reviewer.name };
  });
}

export async function renewApproval(
  c: Context,
  postId: string,
  reviewerId?: string,
) {
  return transaction(async (tx) => {
    const request = (
      await tx.query(
        `SELECT ar.*,p.author_id FROM approval_requests ar
         JOIN posts p ON p.id=ar.post_id AND p.revision=ar.revision
         WHERE ar.organization_id=$1 AND ar.client_id=$2 AND ar.post_id=$3
           AND (
             ar.status='EXPIRED'
             OR (ar.status='PENDING' AND ar.expires_at<=now())
           )
           AND p.status='PENDING_APPROVAL'
         ORDER BY ar.created_at DESC,ar.id DESC LIMIT 1 FOR UPDATE OF ar`,
        [c.organizationId, c.clientId, postId],
      )
    ).rows[0];
    if (!request)
      throw new AppError(
        409,
        "NO_EXPIRED_REVIEW",
        "No expired review is waiting for this post.",
      );
    await tx.query(
      "UPDATE approval_requests SET status='EXPIRED',updated_at=now() WHERE id=$1",
      [request.id],
    );
    const steps = [
      request.step_kind,
      ...request.remaining_steps,
    ] as ReviewKind[];
    let assignedTo: string | undefined;
    if (request.step_kind === "INTERNAL") {
      const requested = reviewerId ?? request.assigned_to ?? c.userId;
      if (requested !== request.assigned_to)
        requireReviewManager(
          c,
          "A social manager or administrator must choose a different reviewer.",
        );
      assignedTo = (await validateReviewer(tx, c, requested, request.author_id))
        .id;
    }
    const next = await insertReview(tx, request, steps, assignedTo);
    await audit(tx, c, "approval.renewed", postId, {
      previousApprovalRequestId: request.id,
      reviewKind: request.step_kind,
      assignedTo,
    });
    await tx.query(
      "INSERT INTO notifications(organization_id,client_id,message,resource_id) VALUES($1,$2,$3,$4)",
      [
        c.organizationId,
        c.clientId,
        "Approval request renewed for seven days",
        postId,
      ],
    );
    return next;
  });
}

export async function sendApprovalReminder(c: Context, postId: string) {
  requireReviewManager(
    c,
    "A social manager or administrator must send review reminders.",
  );
  const reminder = await transaction(async (tx) => {
    const request = (
      await tx.query(
        `SELECT ar.*,u.name AS reviewer_name,u.email AS reviewer_email,
         p.caption,c.name AS client_name,o.timezone
         FROM approval_requests ar
         JOIN posts p ON p.id=ar.post_id AND p.revision=ar.revision
         JOIN clients c ON c.id=ar.client_id
         JOIN organizations o ON o.id=ar.organization_id
         JOIN "user" u ON u.id=ar.assigned_to
         WHERE ar.organization_id=$1 AND ar.client_id=$2 AND ar.post_id=$3
           AND ar.step_kind='INTERNAL' AND ar.status='PENDING'
           AND ar.expires_at>now() AND p.status='PENDING_APPROVAL'
         ORDER BY ar.created_at DESC,ar.id DESC LIMIT 1 FOR UPDATE OF ar`,
        [c.organizationId, c.clientId, postId],
      )
    ).rows[0];
    if (!request)
      throw new AppError(
        409,
        "NO_INTERNAL_REVIEW",
        "No active assigned internal review is waiting for this post.",
      );
    if (
      request.reminder_sent_at &&
      new Date(request.reminder_sent_at).getTime() > Date.now() - 60 * 60 * 1000
    )
      throw new AppError(
        409,
        "REMINDER_COOLDOWN",
        "A reminder was sent less than one hour ago.",
      );
    await tx.query(
      `UPDATE approval_requests
       SET reminder_sent_at=now(),reminder_count=reminder_count+1,
           next_reminder_at=CASE
             WHEN automatic_reminders AND automatic_reminder_count<max_automatic_reminders
             THEN now()+make_interval(hours => repeat_reminder_hours)
           END,updated_at=now()
       WHERE id=$1`,
      [request.id],
    );
    await audit(tx, c, "approval.reminder_sent", postId, {
      approvalRequestId: request.id,
      assignedTo: request.assigned_to,
      reminderCount: request.reminder_count + 1,
    });
    return request;
  });
  let emailDelivered = true;
  try {
    const mail = reviewReminderMail(
      await userLocale({ id: reminder.assigned_to }),
      {
        reviewerName: reminder.reviewer_name,
        clientName: reminder.client_name,
        caption: reminder.caption,
        expiresAt: reminder.expires_at,
        timeZone: reminder.timezone,
        automatic: false,
      },
    );
    await sendMail(reminder.reviewer_email, mail.subject, mail.text);
  } catch (error) {
    emailDelivered = false;
    console.error(
      JSON.stringify({
        event: "approval_reminder_email_failed",
        approvalRequestId: reminder.id,
        errorName: error instanceof Error ? error.name : "Unknown",
      }),
    );
  }
  return {
    reviewerName: reminder.reviewer_name,
    reminderCount: reminder.reminder_count + 1,
    emailDelivered,
  };
}
