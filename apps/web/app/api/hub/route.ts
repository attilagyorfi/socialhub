import { z } from "zod";
import { pool } from "../../../../../packages/db";
import { context, user } from "../../../../../packages/server/context";
import { sameOrigin, AppError } from "../../../../../packages/core/security";
import {
  listClients,
  createClient,
  connectMock,
  disconnect,
} from "../../../../../packages/server/clients";
import {
  editDraft,
  cancelPost,
} from "../../../../../packages/server/post-lifecycle";
import { createPost, schedulePost } from "../../../../../packages/server/posts";
import {
  saveWorkflow,
  rotateReviewLink,
  reviewerCandidates,
} from "../../../../../packages/server/approval-workflows";
import {
  assignApprovalReviewer,
  requestApproval,
  decideApproval,
  expireDueApprovals,
  renewApproval,
  sendApprovalReminder,
} from "../../../../../packages/server/approvals";
import {
  uploadMedia,
  mediaUrl,
  mediaPreviewUrl,
  deleteMedia,
  prepareMediaUpload,
  completeMediaUpload,
} from "../../../../../packages/server/media";
import {
  connectInput,
  postInput,
  uuid,
  brandInput,
  timeZoneInput,
} from "../../../../../packages/server/validation";
import { transaction, audit } from "../../../../../packages/server/transaction";
import { rateLimit } from "../../../../../packages/server/queue";
import { boundedForm } from "../../../../../packages/server/upload-validation";
import {
  checkContent,
  generateContent,
  markGenerationApplied,
} from "../../../../../packages/server/ai";
import { platforms } from "../../../../../packages/core/domain";
import {
  inviteMember,
  listTeam,
  removeMember,
  revokeInvitation,
  updateMember,
} from "../../../../../packages/server/team";
import { memberRole } from "../../../../../packages/server/validation";
import {
  metaIntegrationStatus,
  startMetaOAuth,
} from "../../../../../packages/server/meta";
import { operationalSummary } from "../../../../../packages/server/operations";
import {
  updateUserTimeZone,
  userPreferences,
} from "../../../../../packages/server/preferences";
import {
  cancelPrivacyRequest,
  privacyStatus,
  requestOrganizationErasure,
  requestUserErasure,
  updateRetentionPolicy,
} from "../../../../../packages/server/privacy";
import { queueAnalyticsBackfill } from "../../../../../packages/server/analytics-sync";
import { queueUncertainPublishReconciliation } from "../../../../../packages/server/publish-reconciliation";
export const runtime = "nodejs";
function failure(e: unknown) {
  if (e instanceof z.ZodError)
    return Response.json(
      { error: e.issues.map((i) => i.message).join(" "), code: "VALIDATION" },
      { status: 422 },
    );
  if (e instanceof AppError)
    return Response.json(
      { error: e.message, code: e.code },
      { status: e.status },
    );
  console.error(
    JSON.stringify({
      event: "api_error",
      code: "INTERNAL_ERROR",
      errorName: e instanceof Error ? e.name : "Unknown",
      databaseCode:
        typeof e === "object" && e !== null && "code" in e
          ? String(e.code)
          : undefined,
      location:
        e instanceof Error ? e.stack?.split("\n").slice(1, 3) : undefined,
    }),
  );
  return Response.json(
    {
      error:
        "The service is unavailable. Check that the database and Redis are running.",
      code: "SERVICE_UNAVAILABLE",
    },
    { status: 503 },
  );
}
export async function GET(request: Request) {
  try {
    const actor = await user(request);
    const [clients, preferences, personalPrivacy] = await Promise.all([
      listClients(actor.id),
      userPreferences(actor.id),
      privacyStatus(actor.id),
    ]);
    const url = new URL(request.url);
    const clientId = url.searchParams.get("clientId") ?? clients[0]?.id;
    if (!clientId)
      return Response.json(
        {
          user: {
            id: actor.id,
            name: actor.name,
            email: actor.email,
            timezone: preferences.timezone,
          },
          clients,
          posts: [],
          accounts: [],
          media: [],
          notifications: [],
          audit: [],
          brand: {},
          workflow: ["EXTERNAL"],
          approvalAutomation: {
            automaticReminders: false,
            firstReminderHours: 24,
            repeatReminderHours: 24,
            escalateAfterHours: 72,
            maxAutomaticReminders: 2,
          },
          reviewers: [],
          team: [],
          invitations: [],
          canManageTeam: false,
          operations: null,
          privacy: personalPrivacy,
          role: "",
          page: 0,
          hasMore: false,
          mode: process.env.SOCIAL_PROVIDER_MODE ?? "mock",
          meta: metaIntegrationStatus(),
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    uuid.parse(clientId);
    const c = await context(request, clientId);
    if (url.searchParams.has("mediaId"))
      return Response.json({
        url: await mediaUrl(c, uuid.parse(url.searchParams.get("mediaId"))),
        previewUrl: await mediaPreviewUrl(
          c,
          uuid.parse(url.searchParams.get("mediaId")),
        ),
      });
    await expireDueApprovals(c);
    const page = Math.max(
      0,
      Math.min(10000, Number(url.searchParams.get("page")) || 0),
    );
    const values = [c.organizationId, c.clientId];
    const results = await Promise.all([
      pool.query(
        `SELECT p.*,current_review.step_kind AS approval_kind,
         current_review.status AS approval_status,
         current_review.expires_at AS approval_expires_at,
         current_review.assigned_to AS approval_assigned_to,
         current_review.reviewer_name AS approval_reviewer_name,
         current_review.reminder_sent_at AS approval_reminder_sent_at,
         current_review.reminder_count AS approval_reminder_count,
         current_review.automatic_reminder_count AS approval_automatic_reminder_count,
         current_review.next_reminder_at AS approval_next_reminder_at,
         current_review.escalated_at AS approval_escalated_at,
         coalesce((
           SELECT jsonb_agg(jsonb_build_object(
             'id',history.id,'kind',history.step_kind,'status',history.status,
             'expiresAt',history.expires_at,'createdAt',history.created_at,
             'updatedAt',history.updated_at,'reviewerName',reviewer.name,
             'reminderCount',history.reminder_count,
             'automaticReminderCount',history.automatic_reminder_count,
             'escalatedAt',history.escalated_at
           ) ORDER BY history.created_at DESC,history.id DESC)
           FROM approval_requests history
           LEFT JOIN "user" reviewer ON reviewer.id=history.assigned_to
           WHERE history.post_id=p.id
         ),'[]'::jsonb) AS approval_history,
         coalesce((SELECT jsonb_agg(jsonb_build_object(
           'id',t.id,'accountId',t.social_account_id,'platform',a.platform,
           'caption',t.caption,'status',t.status,'mediaIds',t.media_ids,
           'errorCode',t.error_code
         )) FROM post_targets t JOIN social_accounts a ON a.id=t.social_account_id
         WHERE t.post_id=p.id),'[]'::jsonb) AS targets
         FROM posts p
         LEFT JOIN LATERAL (
           SELECT ar.*,reviewer.name AS reviewer_name
           FROM approval_requests ar
           LEFT JOIN "user" reviewer ON reviewer.id=ar.assigned_to
           WHERE ar.post_id=p.id AND ar.revision=p.revision
           ORDER BY ar.created_at DESC,ar.id DESC LIMIT 1
         ) current_review ON true
         WHERE p.organization_id=$1 AND p.client_id=$2 AND p.deleted_at IS NULL
         ORDER BY p.created_at DESC LIMIT 50 OFFSET $3`,
        [...values, page * 50],
      ),
      pool.query(
        "SELECT id,platform,name,mode,status,token_health,capabilities,last_sync_at FROM social_accounts WHERE organization_id=$1 AND client_id=$2 AND deleted_at IS NULL ORDER BY created_at",
        values,
      ),
      pool.query(
        "SELECT id,name,mime_type,size_bytes,width,height,duration_seconds,status FROM media_assets WHERE organization_id=$1 AND client_id=$2 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 50",
        values,
      ),
      pool.query(
        "SELECT id,message,resource_id,created_at FROM notifications WHERE organization_id=$1 AND client_id=$2 ORDER BY created_at DESC LIMIT 30",
        values,
      ),
      pool.query(
        "SELECT action,resource_id,metadata,created_at FROM audit_logs WHERE organization_id=$1 AND client_id=$2 ORDER BY created_at DESC LIMIT 50",
        values,
      ),
      pool.query(
        "SELECT profile FROM brand_profiles WHERE organization_id=$1 AND client_id=$2",
        values,
      ),
      pool.query(
        "SELECT s.kind FROM approval_steps s JOIN approval_workflows w ON w.id=s.workflow_id WHERE w.organization_id=$1 AND w.client_id=$2 AND w.is_default ORDER BY s.position",
        values,
      ),
      pool.query(
        `SELECT automatic_reminders,first_reminder_hours,repeat_reminder_hours,
                escalate_after_hours,max_automatic_reminders
         FROM approval_workflows
         WHERE organization_id=$1 AND client_id=$2 AND is_default`,
        values,
      ),
    ]);
    const canManageTeam = ["OWNER", "ADMIN"].includes(c.role);
    const [team, operations, reviewers, privacy] = await Promise.all([
      canManageTeam
        ? listTeam(c)
        : Promise.resolve({ members: [], invitations: [] }),
      canManageTeam ? operationalSummary(c) : Promise.resolve(null),
      c.role === "VIEWER" ? Promise.resolve([]) : reviewerCandidates(c),
      privacyStatus(actor.id, c.organizationId),
    ]);
    return Response.json(
      {
        user: {
          id: actor.id,
          name: actor.name,
          email: actor.email,
          timezone: preferences.timezone,
        },
        clients,
        clientId,
        role: c.role,
        posts: results[0].rows,
        accounts: results[1].rows,
        media: results[2].rows,
        notifications: results[3].rows,
        audit: results[4].rows,
        brand: results[5].rows[0]?.profile ?? {},
        workflow: results[6].rows.length
          ? results[6].rows.map((r) => r.kind)
          : ["EXTERNAL"],
        approvalAutomation: results[7].rows[0]
          ? {
              automaticReminders: results[7].rows[0].automatic_reminders,
              firstReminderHours: results[7].rows[0].first_reminder_hours,
              repeatReminderHours: results[7].rows[0].repeat_reminder_hours,
              escalateAfterHours: results[7].rows[0].escalate_after_hours,
              maxAutomaticReminders: results[7].rows[0].max_automatic_reminders,
            }
          : {
              automaticReminders: false,
              firstReminderHours: 24,
              repeatReminderHours: 24,
              escalateAfterHours: 72,
              maxAutomaticReminders: 2,
            },
        reviewers,
        team: team.members,
        invitations: team.invitations,
        canManageTeam,
        operations,
        privacy,
        page,
        hasMore: results[0].rows.length === 50,
        mode: process.env.SOCIAL_PROVIDER_MODE ?? "mock",
        meta: metaIntegrationStatus(),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return failure(e);
  }
}
export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const actor = await user(request);
    if (!(await rateLimit(actor.id)))
      throw new AppError(
        429,
        "RATE_LIMIT",
        "Too many requests. Try again shortly.",
      );
    if (request.headers.get("content-type")?.includes("multipart/form-data")) {
      const data = await boundedForm(request);
      const c = await context(
        request,
        uuid.parse(data.get("clientId")),
        "create",
      );
      const file = data.get("file");
      if (!(file instanceof File))
        throw new AppError(422, "FILE_REQUIRED", "Choose a file.");
      return Response.json(await uploadMedia(c, file));
    }
    const body = await request.json();
    const action = z.string().parse(body.action);
    if (action === "preferences.update")
      return Response.json(
        await updateUserTimeZone(actor.id, timeZoneInput.parse(body.timezone)),
      );
    if (action === "privacy.user.erase.request")
      return Response.json(
        await requestUserErasure(
          actor.id,
          z.string().trim().max(320).parse(body.confirmation),
        ),
      );
    if (action === "privacy.request.cancel")
      return Response.json(
        await cancelPrivacyRequest(actor.id, uuid.parse(body.requestId)),
      );
    if (action === "client.create")
      return Response.json(
        await createClient(
          actor.id,
          z.string().trim().min(1).max(120).parse(body.name),
          body.organizationId ? uuid.parse(body.organizationId) : undefined,
        ),
      );
    const c = await context(
      request,
      uuid.parse(body.clientId),
      action === "post.review" || action === "post.review.assign"
        ? "approve"
        : action === "post.schedule" || action === "post.cancel"
          ? "publish"
          : action === "account.connect" ||
              action === "account.oauth.start" ||
              action === "account.disconnect" ||
              action === "brand.save" ||
              action === "workflow.save" ||
              action === "privacy.organization.erase.request" ||
              action === "privacy.retention.update" ||
              action === "analytics.backfill" ||
              action === "publishing.reconcile" ||
              action.startsWith("team.")
            ? "manage"
            : "create",
    );
    switch (action) {
      case "account.oauth.start":
        return Response.json(await startMetaOAuth(c));
      case "privacy.organization.erase.request":
        return Response.json(
          await requestOrganizationErasure(
            c,
            z.string().trim().max(120).parse(body.confirmation),
          ),
        );
      case "privacy.retention.update":
        return Response.json(
          await updateRetentionPolicy(
            c,
            z.number().int().min(30).max(3650).parse(body.retentionDays),
          ),
        );
      case "analytics.backfill":
        return Response.json(
          await queueAnalyticsBackfill(
            c,
            z.number().int().min(1).max(90).parse(body.days),
          ),
        );
      case "publishing.reconcile":
        return Response.json(await queueUncertainPublishReconciliation(c));
      case "account.connect": {
        const input = connectInput.parse(body);
        return Response.json(await connectMock(c, input.platform, input.name));
      }
      case "account.disconnect":
        await disconnect(c, uuid.parse(body.id));
        break;
      case "post.create":
        return Response.json(await createPost(c, postInput.parse(body)));
      case "post.edit":
        return Response.json(
          await editDraft(c, uuid.parse(body.id), postInput.parse(body)),
        );
      case "post.cancel":
        return Response.json(await cancelPost(c, uuid.parse(body.id)));
      case "workflow.save":
        return Response.json(
          await saveWorkflow(
            c,
            z
              .array(z.enum(["INTERNAL", "EXTERNAL"]))
              .min(1)
              .max(2)
              .parse(body.steps),
            body.automation
              ? z
                  .object({
                    automaticReminders: z.boolean(),
                    firstReminderHours: z.number().int().min(1).max(168),
                    repeatReminderHours: z.number().int().min(1).max(168),
                    escalateAfterHours: z.number().int().min(1).max(168),
                    maxAutomaticReminders: z.number().int().min(0).max(10),
                  })
                  .parse(body.automation)
              : undefined,
          ),
        );
      case "post.review":
        return Response.json(
          await decideApproval(
            uuid.parse(body.id),
            z.enum(["approve", "changes", "comment"]).parse(body.decision),
            z
              .string()
              .max(5000)
              .parse(body.comment ?? ""),
            c,
          ),
        );
      case "post.review.assign":
        return Response.json(
          await assignApprovalReviewer(
            c,
            uuid.parse(body.id),
            uuid.parse(body.reviewerId),
          ),
        );
      case "post.review.remind":
        return Response.json(
          await sendApprovalReminder(c, uuid.parse(body.id)),
        );
      case "post.review.renew":
        return Response.json(
          await renewApproval(
            c,
            uuid.parse(body.id),
            body.reviewerId ? uuid.parse(body.reviewerId) : undefined,
          ),
        );
      case "post.approval-link":
        return Response.json(await rotateReviewLink(c, uuid.parse(body.id)));
      case "post.submit":
        return Response.json(
          await requestApproval(
            c,
            uuid.parse(body.id),
            body.reviewerId ? uuid.parse(body.reviewerId) : undefined,
          ),
        );
      case "post.schedule":
        return Response.json(
          await schedulePost(
            c,
            uuid.parse(body.id),
            z.iso.datetime({ offset: true }).parse(body.scheduledAt),
          ),
        );
      case "brand.save": {
        const brand = brandInput.parse(body.brand);
        await transaction(async (tx) => {
          await tx.query(
            "UPDATE brand_profiles SET profile=$1,updated_at=now() WHERE organization_id=$2 AND client_id=$3",
            [JSON.stringify(brand), c.organizationId, c.clientId],
          );
          await audit(tx, c, "brand.updated", c.clientId);
        });
        break;
      }
      case "team.invite":
        return Response.json(
          await inviteMember(
            c,
            z.email().parse(body.email),
            memberRole.parse(body.role),
            z
              .array(uuid)
              .max(100)
              .parse(body.clientIds ?? []),
          ),
        );
      case "team.member.update":
        return Response.json(
          await updateMember(
            c,
            uuid.parse(body.userId),
            memberRole.parse(body.role),
            z
              .array(uuid)
              .max(100)
              .parse(body.clientIds ?? []),
          ),
        );
      case "team.member.remove":
        return Response.json(await removeMember(c, uuid.parse(body.userId)));
      case "team.invitation.revoke":
        return Response.json(
          await revokeInvitation(c, uuid.parse(body.invitationId)),
        );
      case "media.delete":
        await deleteMedia(c, uuid.parse(body.id));
        break;
      case "media.upload.prepare":
        return Response.json(
          await prepareMediaUpload(c, {
            name: z.string().trim().min(1).max(200).parse(body.name),
            mimeType: z
              .enum(["image/png", "image/jpeg", "image/webp", "video/mp4"])
              .parse(body.mimeType),
            sizeBytes: z
              .number()
              .int()
              .min(1)
              .max(20 * 1024 * 1024)
              .parse(body.sizeBytes),
          }),
        );
      case "media.upload.complete":
        return Response.json(await completeMediaUpload(c, uuid.parse(body.id)));
      case "ai.generate": {
        return Response.json(
          await generateContent(c, {
            operation: z
              .enum([
                "generate",
                "alternatives",
                "rewrite",
                "shorten",
                "expand",
                "professional",
                "casual",
                "facebook",
                "instagram",
                "linkedin",
                "tiktok",
                "hashtags",
                "cta",
                "translate",
                "ideas",
                "series",
              ])
              .parse(body.operation),
            text: z.string().max(10000).parse(body.text),
            platforms: z
              .array(z.enum(platforms))
              .max(15)
              .parse(body.platforms ?? []),
            postId: body.postId ? uuid.parse(body.postId) : undefined,
          }),
        );
      }
      case "ai.check":
        return Response.json(
          await checkContent(
            c,
            z.string().max(63206).parse(body.text),
            z
              .array(z.enum(platforms))
              .max(15)
              .parse(body.platforms ?? []),
          ),
        );
      case "ai.apply":
        return Response.json(
          await markGenerationApplied(c, uuid.parse(body.id)),
        );
      default:
        throw new AppError(404, "UNKNOWN_ACTION", "Unknown action.");
    }
    return Response.json({ ok: true });
  } catch (e) {
    return failure(e);
  }
}
