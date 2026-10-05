import { createHash } from "node:crypto";
import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import { pool } from "../db";
import { AppError } from "../core/security";
import type { Context } from "./context";
import { mediaBucket, storageClient } from "./media";
import { audit, transaction } from "./transaction";

type PrivacyRequest = {
  id: string;
  request_type: "USER_ERASURE" | "ORGANIZATION_ERASURE";
  status: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
  organization_id: string | null;
  subject_user_id: string | null;
  execute_after: Date | string;
  attempts: number;
  metadata: Record<string, unknown>;
};

const emailHash = (email: string) =>
  createHash("sha256").update(email.trim().toLowerCase()).digest("hex");

function requestView(request: PrivacyRequest | undefined) {
  if (!request) return null;
  return {
    id: request.id,
    type: request.request_type,
    status: request.status,
    executeAfter: new Date(request.execute_after).toISOString(),
    attempts: request.attempts,
    errorCode: (request as PrivacyRequest & { error_code?: string }).error_code,
  };
}

export async function privacyStatus(userId: string, organizationId?: string) {
  const [userRequest, organization] = await Promise.all([
    pool.query(
      `SELECT * FROM privacy_requests
       WHERE request_type='USER_ERASURE' AND subject_user_id=$1
         AND status IN ('PENDING','RUNNING','FAILED')
       ORDER BY created_at DESC LIMIT 1`,
      [userId],
    ),
    organizationId
      ? pool.query(
          `SELECT o.id,o.name,o.retention_days,om.role,
                  (SELECT row_to_json(pr) FROM (
                    SELECT id,request_type,status,execute_after,attempts,error_code
                    FROM privacy_requests
                    WHERE organization_id=o.id
                      AND request_type='ORGANIZATION_ERASURE'
                      AND status IN ('PENDING','RUNNING','FAILED')
                    ORDER BY created_at DESC LIMIT 1
                  ) pr) AS request
           FROM organizations o
           JOIN organization_members om ON om.organization_id=o.id
           WHERE o.id=$1 AND om.user_id=$2 AND o.deleted_at IS NULL`,
          [organizationId, userId],
        )
      : Promise.resolve({ rows: [] }),
  ]);
  const org = organization.rows[0];
  return {
    userRequest: requestView(userRequest.rows[0]),
    organization: org
      ? {
          id: org.id,
          name: org.name,
          retentionDays: org.retention_days,
          canDelete: org.role === "OWNER",
          canManageRetention: ["OWNER", "ADMIN"].includes(org.role),
          request: requestView(org.request),
        }
      : null,
  };
}

async function auditForUser(
  tx: import("pg").PoolClient,
  userId: string,
  action: string,
  requestId: string,
  metadata: Record<string, unknown> = {},
) {
  await tx.query(
    `INSERT INTO audit_logs(
       organization_id,client_id,actor_id,action,resource_id,metadata
     )
     SELECT organization_id,NULL,$1,$2,$3,$4
     FROM organization_members WHERE user_id=$1`,
    [userId, action, requestId, JSON.stringify(metadata)],
  );
}

export async function requestUserErasure(userId: string, confirmation: string) {
  return transaction(async (tx) => {
    const person = (
      await tx.query(`SELECT id,email FROM "user" WHERE id=$1 FOR UPDATE`, [
        userId,
      ])
    ).rows[0];
    if (!person) throw new AppError(404, "NOT_FOUND", "User not found.");
    if (confirmation.trim().toLowerCase() !== person.email.toLowerCase())
      throw new AppError(
        422,
        "CONFIRMATION_MISMATCH",
        "Enter your email address exactly to request account deletion.",
      );
    const soleOwnership = (
      await tx.query(
        `SELECT o.name FROM organization_members own
         JOIN organizations o ON o.id=own.organization_id AND o.deleted_at IS NULL
         WHERE own.user_id=$1 AND own.role='OWNER'
           AND NOT EXISTS(
             SELECT 1 FROM organization_members other
             WHERE other.organization_id=own.organization_id
               AND other.role='OWNER' AND other.user_id<>$1
           )
         LIMIT 1`,
        [userId],
      )
    ).rows[0];
    if (soleOwnership)
      throw new AppError(
        409,
        "SOLE_OWNER",
        `Transfer ownership or delete ${soleOwnership.name} before deleting your account.`,
      );
    const existing = await tx.query(
      `SELECT id FROM privacy_requests
       WHERE request_type='USER_ERASURE' AND subject_user_id=$1
         AND status IN ('PENDING','RUNNING','FAILED')`,
      [userId],
    );
    if (existing.rowCount)
      throw new AppError(
        409,
        "PRIVACY_REQUEST_EXISTS",
        "An account deletion request already exists.",
      );
    const request = (
      await tx.query(
        `INSERT INTO privacy_requests(
           request_type,subject_user_id,requester_id,subject_email_hash,
           execute_after,run_at
         ) VALUES('USER_ERASURE',$1,$1,$2,now()+interval '24 hours',
                  now()+interval '24 hours')
         RETURNING *`,
        [userId, emailHash(person.email)],
      )
    ).rows[0];
    await auditForUser(
      tx,
      userId,
      "privacy.user_erasure_requested",
      request.id,
      {
        executeAfter: new Date(request.execute_after).toISOString(),
      },
    );
    return requestView(request);
  });
}

export async function requestOrganizationErasure(
  c: Context,
  confirmation: string,
) {
  if (c.role !== "OWNER")
    throw new AppError(
      403,
      "OWNER_REQUIRED",
      "Only an organization owner can request organization deletion.",
    );
  return transaction(async (tx) => {
    const organization = (
      await tx.query(
        `SELECT id,name FROM organizations
         WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`,
        [c.organizationId],
      )
    ).rows[0];
    if (!organization)
      throw new AppError(404, "NOT_FOUND", "Organization not found.");
    if (confirmation.trim() !== organization.name)
      throw new AppError(
        422,
        "CONFIRMATION_MISMATCH",
        "Enter the organization name exactly to request deletion.",
      );
    const liveCredential = (
      await tx.query(
        `SELECT a.platform FROM social_credentials sc
         JOIN social_accounts a ON a.id=sc.social_account_id
         WHERE sc.organization_id=$1 AND a.mode<>'mock' LIMIT 1`,
        [c.organizationId],
      )
    ).rows[0];
    if (liveCredential)
      throw new AppError(
        409,
        "CREDENTIAL_REVOCATION_REQUIRED",
        `Disconnect and revoke the ${liveCredential.platform} provider grant before deleting this organization.`,
      );
    const existing = await tx.query(
      `SELECT id FROM privacy_requests
       WHERE request_type='ORGANIZATION_ERASURE' AND organization_id=$1
         AND status IN ('PENDING','RUNNING','FAILED')`,
      [c.organizationId],
    );
    if (existing.rowCount)
      throw new AppError(
        409,
        "PRIVACY_REQUEST_EXISTS",
        "An organization deletion request already exists.",
      );
    const request = (
      await tx.query(
        `INSERT INTO privacy_requests(
           request_type,organization_id,requester_id,execute_after,run_at,metadata
         ) VALUES('ORGANIZATION_ERASURE',$1,$2,now()+interval '72 hours',
                  now()+interval '72 hours',$3)
         RETURNING *`,
        [
          c.organizationId,
          c.userId,
          JSON.stringify({ organizationName: organization.name }),
        ],
      )
    ).rows[0];
    await audit(tx, c, "privacy.organization_erasure_requested", request.id, {
      executeAfter: new Date(request.execute_after).toISOString(),
    });
    return requestView(request);
  });
}

export async function cancelPrivacyRequest(userId: string, requestId: string) {
  return transaction(async (tx) => {
    const request = (
      await tx.query(`SELECT * FROM privacy_requests WHERE id=$1 FOR UPDATE`, [
        requestId,
      ])
    ).rows[0];
    if (!request)
      throw new AppError(404, "NOT_FOUND", "Privacy request not found.");
    if (request.status === "RUNNING")
      throw new AppError(
        409,
        "REQUEST_RUNNING",
        "This deletion is already being processed.",
      );
    if (!["PENDING", "FAILED"].includes(request.status))
      throw new AppError(
        409,
        "REQUEST_CLOSED",
        "This privacy request is already closed.",
      );
    if (request.request_type === "USER_ERASURE") {
      if (request.subject_user_id !== userId)
        throw new AppError(404, "NOT_FOUND", "Privacy request not found.");
      await auditForUser(
        tx,
        userId,
        "privacy.user_erasure_cancelled",
        request.id,
      );
    } else {
      const membership = (
        await tx.query(
          `SELECT role FROM organization_members
           WHERE organization_id=$1 AND user_id=$2`,
          [request.organization_id, userId],
        )
      ).rows[0];
      if (membership?.role !== "OWNER")
        throw new AppError(404, "NOT_FOUND", "Privacy request not found.");
      await tx.query(
        `INSERT INTO audit_logs(
           organization_id,client_id,actor_id,action,resource_id
         ) VALUES($1,NULL,$2,'privacy.organization_erasure_cancelled',$3)`,
        [request.organization_id, userId, request.id],
      );
    }
    await tx.query(
      `UPDATE privacy_requests
       SET status='CANCELLED',updated_at=now(),error_code=NULL WHERE id=$1`,
      [request.id],
    );
    return { id: request.id, status: "CANCELLED" };
  });
}

export async function updateRetentionPolicy(c: Context, retentionDays: number) {
  if (!["OWNER", "ADMIN"].includes(c.role))
    throw new AppError(
      403,
      "FORBIDDEN",
      "Only organization administrators can change retention.",
    );
  return transaction(async (tx) => {
    const previous = (
      await tx.query(
        `SELECT retention_days FROM organizations WHERE id=$1 FOR UPDATE`,
        [c.organizationId],
      )
    ).rows[0];
    if (!previous)
      throw new AppError(404, "NOT_FOUND", "Organization not found.");
    await tx.query(
      `UPDATE organizations
       SET retention_days=$1,retention_last_run_at=NULL,updated_at=now()
       WHERE id=$2`,
      [retentionDays, c.organizationId],
    );
    await audit(tx, c, "privacy.retention_updated", c.organizationId, {
      previousDays: previous.retention_days,
      retentionDays,
    });
    return { retentionDays };
  });
}

export async function exportUserData(userId: string) {
  const profile = (
    await pool.query(
      `SELECT id,name,email,"emailVerified",image,timezone,"createdAt","updatedAt"
       FROM "user" WHERE id=$1`,
      [userId],
    )
  ).rows[0];
  if (!profile) throw new AppError(404, "NOT_FOUND", "User not found.");
  const [
    authenticationMethods,
    organizations,
    clients,
    posts,
    generations,
    approvals,
    approvalDeliveries,
    comments,
    events,
    invitations,
    requests,
  ] = await Promise.all([
    pool.query(
      `SELECT id,"accountId","providerId",scope,"createdAt","updatedAt"
         FROM account WHERE "userId"=$1 ORDER BY "createdAt"`,
      [userId],
    ),
    pool.query(
      `SELECT o.id,o.name,om.role,om.created_at
         FROM organization_members om JOIN organizations o ON o.id=om.organization_id
         WHERE om.user_id=$1 ORDER BY om.created_at`,
      [userId],
    ),
    pool.query(
      `SELECT c.id,c.name,cm.role,cm.created_at
         FROM client_members cm JOIN clients c ON c.id=cm.client_id
         WHERE cm.user_id=$1 ORDER BY cm.created_at`,
      [userId],
    ),
    pool.query(
      `SELECT id,organization_id,client_id,caption,link,status,scheduled_at,
                created_at,updated_at
         FROM posts WHERE author_id=$1 ORDER BY created_at`,
      [userId],
    ),
    pool.query(
      `SELECT id,organization_id,client_id,post_id,operation,provider,model,
                mode,status,input,output,error_code,applied_at,created_at,completed_at
         FROM ai_generations WHERE user_id=$1 ORDER BY created_at`,
      [userId],
    ),
    pool.query(
      `SELECT id,organization_id,client_id,post_id,step_kind,status,
                expires_at,created_at,updated_at
         FROM approval_requests WHERE assigned_to=$1 ORDER BY created_at`,
      [userId],
    ),
    pool.query(
      `SELECT id,organization_id,client_id,approval_request_id,kind,sequence,
                recipient_email,status,attempts,run_at,sent_at,error_code,
                created_at,updated_at
         FROM approval_automation_deliveries
         WHERE recipient_user_id=$1 ORDER BY created_at`,
      [userId],
    ),
    pool.query(
      `SELECT id,organization_id,client_id,approval_request_id,body,created_at
         FROM approval_comments WHERE author_user_id=$1 ORDER BY created_at`,
      [userId],
    ),
    pool.query(
      `SELECT organization_id,client_id,action,resource_id,metadata,created_at
         FROM audit_logs WHERE actor_id=$1 ORDER BY created_at`,
      [userId],
    ),
    pool.query(
      `SELECT organization_id,email,role,status,expires_at,accepted_at,created_at
         FROM member_invitations WHERE lower(email)=lower($1) ORDER BY created_at`,
      [profile.email],
    ),
    pool.query(
      `SELECT id,request_type,status,execute_after,error_code,created_at,completed_at
         FROM privacy_requests WHERE subject_user_id=$1 OR requester_id=$1
         ORDER BY created_at`,
      [userId],
    ),
  ]);
  await pool.query(
    `INSERT INTO audit_logs(
       organization_id,client_id,actor_id,action,resource_id
     )
     SELECT organization_id,NULL,$1,'privacy.user_data_exported',$1
     FROM organization_members WHERE user_id=$1`,
    [userId],
  );
  return {
    format: "g2a-social-hub-personal-data-v1",
    generatedAt: new Date().toISOString(),
    profile,
    authenticationMethods: authenticationMethods.rows,
    memberships: {
      organizations: organizations.rows,
      clients: clients.rows,
    },
    authoredPosts: posts.rows,
    aiGenerations: generations.rows,
    assignedApprovals: approvals.rows,
    approvalDeliveries: approvalDeliveries.rows,
    approvalComments: comments.rows,
    auditEvents: events.rows,
    invitations: invitations.rows,
    privacyRequests: requests.rows,
  };
}

async function deleteStorageKeys(keys: string[]) {
  await Promise.all(
    Array.from(new Set(keys.filter(Boolean))).map((Key) =>
      storageClient().send(
        new DeleteObjectCommand({ Bucket: mediaBucket(), Key }),
      ),
    ),
  );
}

async function eraseUser(request: PrivacyRequest) {
  await transaction(async (tx) => {
    const person = (
      await tx.query(`SELECT * FROM "user" WHERE id=$1 FOR UPDATE`, [
        request.subject_user_id,
      ])
    ).rows[0];
    if (!person) {
      await tx.query(
        `UPDATE privacy_requests
         SET status='COMPLETED',completed_at=now(),updated_at=now(),error_code=NULL
         WHERE id=$1`,
        [request.id],
      );
      return;
    }
    const soleOwner = await tx.query(
      `SELECT 1 FROM organization_members own
       JOIN organizations o ON o.id=own.organization_id AND o.deleted_at IS NULL
       WHERE own.user_id=$1 AND own.role='OWNER'
         AND NOT EXISTS(
           SELECT 1 FROM organization_members other
           WHERE other.organization_id=own.organization_id
             AND other.role='OWNER' AND other.user_id<>$1
         ) LIMIT 1`,
      [person.id],
    );
    if (soleOwner.rowCount)
      throw new AppError(
        409,
        "SOLE_OWNER",
        "Account deletion is blocked while the user is a sole owner.",
      );
    await tx.query(
      `UPDATE approval_requests ar SET assigned_to=(
         SELECT om.user_id FROM organization_members om
         WHERE om.organization_id=ar.organization_id AND om.user_id<>$1
           AND om.role IN ('OWNER','ADMIN') ORDER BY om.created_at LIMIT 1
       ),updated_at=now()
       WHERE ar.assigned_to=$1 AND ar.status='PENDING'`,
      [person.id],
    );
    await tx.query(
      `UPDATE approval_automation_deliveries
       SET recipient_user_id=NULL,
           recipient_email='redacted+'||id::text||'@invalid.example',
           status=CASE WHEN status IN ('PENDING','FAILED','SENDING')
                       THEN 'CANCELLED' ELSE status END,
           error_code=CASE WHEN status IN ('PENDING','FAILED','SENDING')
                           THEN 'SUBJECT_ERASED' ELSE error_code END,
           updated_at=now()
       WHERE recipient_user_id=$1`,
      [person.id],
    );
    await tx.query(
      `UPDATE approval_comments
       SET author='Deleted user',body='[Removed during account deletion]',
           author_user_id=NULL WHERE author_user_id=$1`,
      [person.id],
    );
    await tx.query(`DELETE FROM ai_generations WHERE user_id=$1`, [person.id]);
    await tx.query(
      `DELETE FROM member_invitations WHERE lower(email)=lower($1)`,
      [person.email],
    );
    await tx.query(
      `UPDATE audit_logs SET metadata=metadata-'email'-'actor'-'assignedTo'
       WHERE actor_id=$1 OR resource_id=$1`,
      [person.id],
    );
    await auditForUser(
      tx,
      person.id,
      "privacy.user_erasure_completed",
      request.id,
    );
    await tx.query(`DELETE FROM "user" WHERE id=$1`, [person.id]);
    await tx.query(
      `UPDATE privacy_requests
       SET status='COMPLETED',completed_at=now(),updated_at=now(),error_code=NULL
       WHERE id=$1`,
      [request.id],
    );
  });
}

async function eraseOrganization(request: PrivacyRequest) {
  const organization = (
    await pool.query(`SELECT name FROM organizations WHERE id=$1`, [
      request.organization_id,
    ])
  ).rows[0];
  if (!organization) {
    await pool.query(
      `UPDATE privacy_requests
       SET status='COMPLETED',completed_at=now(),updated_at=now(),error_code=NULL
       WHERE id=$1`,
      [request.id],
    );
    return;
  }
  const liveCredentials = await pool.query(
    `SELECT 1 FROM social_credentials sc
     JOIN social_accounts a ON a.id=sc.social_account_id
     WHERE sc.organization_id=$1 AND a.mode<>'mock' LIMIT 1`,
    [request.organization_id],
  );
  if (liveCredentials.rowCount)
    throw new AppError(
      409,
      "CREDENTIAL_REVOCATION_REQUIRED",
      "Provider credentials must be revoked before organization deletion.",
    );
  const media = (
    await pool.query(
      `SELECT object_key,preview_object_key FROM media_assets
       WHERE organization_id=$1`,
      [request.organization_id],
    )
  ).rows;
  await deleteStorageKeys(
    media.flatMap((item) => [item.object_key, item.preview_object_key]),
  );
  await transaction(async (tx) => {
    await tx.query(`DELETE FROM organizations WHERE id=$1`, [
      request.organization_id,
    ]);
    await tx.query(
      `UPDATE privacy_requests
       SET status='COMPLETED',completed_at=now(),updated_at=now(),error_code=NULL,
           metadata=metadata||$2::jsonb WHERE id=$1`,
      [
        request.id,
        JSON.stringify({
          deletedOrganizationName: organization.name,
          deletedMediaObjects: media.length,
        }),
      ],
    );
  });
}

export async function processErasureRequests(limit = 10) {
  let completed = 0;
  let failed = 0;
  for (let index = 0; index < Math.max(1, Math.min(limit, 50)); index++) {
    const request = await transaction(async (tx) => {
      const row = (
        await tx.query(
          `SELECT * FROM privacy_requests
           WHERE status IN ('PENDING','FAILED') AND attempts<3
             AND execute_after<=now() AND run_at<=now()
           ORDER BY run_at,created_at LIMIT 1
           FOR UPDATE SKIP LOCKED`,
        )
      ).rows[0];
      if (!row) return null;
      await tx.query(
        `UPDATE privacy_requests
         SET status='RUNNING',attempts=attempts+1,error_code=NULL,updated_at=now()
         WHERE id=$1`,
        [row.id],
      );
      return { ...row, attempts: row.attempts + 1 } as PrivacyRequest;
    });
    if (!request) break;
    try {
      if (request.request_type === "USER_ERASURE") await eraseUser(request);
      else await eraseOrganization(request);
      completed++;
    } catch (error) {
      const code = error instanceof AppError ? error.code : "ERASURE_FAILED";
      await pool.query(
        `UPDATE privacy_requests
         SET status='FAILED',error_code=$2,
             run_at=now()+make_interval(hours => power(2,least(attempts,5))::integer),
             updated_at=now() WHERE id=$1`,
        [request.id, code],
      );
      console.error(
        JSON.stringify({
          event: "privacy_erasure_failed",
          requestId: request.id,
          code,
        }),
      );
      failed++;
    }
  }
  return { completed, failed };
}

export async function processRetentionPolicies(
  limit = 10,
  organizationId?: string,
) {
  const organizations = await transaction(async (tx) => {
    const rows = (
      await tx.query(
        `SELECT id,retention_days FROM organizations
         WHERE deleted_at IS NULL
           AND ($2::uuid IS NULL OR id=$2)
           AND (retention_last_run_at IS NULL
                OR retention_last_run_at<now()-interval '24 hours')
         ORDER BY retention_last_run_at NULLS FIRST,id LIMIT $1
         FOR UPDATE SKIP LOCKED`,
        [Math.max(1, Math.min(limit, 50)), organizationId ?? null],
      )
    ).rows;
    for (const organization of rows)
      await tx.query(
        `UPDATE organizations SET retention_last_run_at=now() WHERE id=$1`,
        [organization.id],
      );
    return rows;
  });
  let completed = 0;
  let failed = 0;
  for (const organization of organizations) {
    try {
      const expiredMedia = (
        await pool.query(
          `SELECT id,object_key,preview_object_key FROM media_assets
           WHERE organization_id=$1 AND deleted_at IS NOT NULL
             AND deleted_at<now()-make_interval(days => $2)`,
          [organization.id, organization.retention_days],
        )
      ).rows;
      await deleteStorageKeys(
        expiredMedia.flatMap((item) => [
          item.object_key,
          item.preview_object_key,
        ]),
      );
      await transaction(async (tx) => {
        const values = [organization.id, organization.retention_days];
        const counts: Record<string, number> = {};
        const remove = async (name: string, query: string) => {
          counts[name] = (await tx.query(query, values)).rowCount ?? 0;
        };
        await remove(
          "approvalRequests",
          `DELETE FROM approval_requests WHERE organization_id=$1
           AND status<>'PENDING'
           AND updated_at<now()-make_interval(days => $2)`,
        );
        await remove(
          "publishJobs",
          `DELETE FROM publish_jobs WHERE organization_id=$1
           AND status IN ('DONE','DEAD','CANCELLED')
           AND updated_at<now()-make_interval(days => $2)`,
        );
        await remove(
          "webhooks",
          `DELETE FROM webhook_events WHERE organization_id=$1
           AND created_at<now()-make_interval(days => $2)`,
        );
        await remove(
          "notifications",
          `DELETE FROM notifications WHERE organization_id=$1
           AND created_at<now()-make_interval(days => $2)`,
        );
        await remove(
          "postMetrics",
          `DELETE FROM post_metrics WHERE organization_id=$1
           AND captured_at<now()-make_interval(days => $2)`,
        );
        await remove(
          "analyticsSyncJobs",
          `DELETE FROM analytics_sync_jobs WHERE organization_id=$1
           AND status IN ('DONE','DEAD')
           AND updated_at<now()-make_interval(days => $2)`,
        );
        await remove(
          "analytics",
          `DELETE FROM analytics_daily WHERE organization_id=$1
           AND day<(current_date-$2::integer)`,
        );
        await remove(
          "aiGenerations",
          `DELETE FROM ai_generations WHERE organization_id=$1
           AND created_at<now()-make_interval(days => $2)`,
        );
        await remove(
          "invitations",
          `DELETE FROM member_invitations WHERE organization_id=$1
           AND status<>'PENDING'
           AND updated_at<now()-make_interval(days => $2)`,
        );
        await remove(
          "media",
          `DELETE FROM media_assets WHERE organization_id=$1
           AND deleted_at IS NOT NULL
           AND deleted_at<now()-make_interval(days => $2)`,
        );
        await remove(
          "posts",
          `DELETE FROM posts WHERE organization_id=$1
           AND deleted_at IS NOT NULL
           AND deleted_at<now()-make_interval(days => $2)`,
        );
        await remove(
          "auditEvents",
          `DELETE FROM audit_logs WHERE organization_id=$1
           AND created_at<now()-make_interval(days => $2)`,
        );
        await tx.query(
          `INSERT INTO audit_logs(
             organization_id,client_id,action,resource_id,metadata
           ) VALUES($1,NULL,'privacy.retention_executed',$1,$2)`,
          [
            organization.id,
            JSON.stringify({ retentionDays: values[1], counts }),
          ],
        );
      });
      completed++;
    } catch {
      await pool.query(
        `UPDATE organizations SET retention_last_run_at=NULL WHERE id=$1`,
        [organization.id],
      );
      console.error(
        JSON.stringify({
          event: "privacy_retention_failed",
          organizationId: organization.id,
          code: "RETENTION_FAILED",
        }),
      );
      failed++;
    }
  }
  return { completed, failed };
}

export async function processPrivacyMaintenance(limit = 10) {
  const erasures = await processErasureRequests(limit);
  const retention = await processRetentionPolicies(limit);
  return { erasures, retention };
}
