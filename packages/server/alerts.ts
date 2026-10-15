import * as Sentry from "@sentry/node";
import { pool } from "../db";
import { sendMail } from "./mail";
import {
  operationalAlertMail,
  type OperationalAlertGroup,
} from "./mail-templates";

export type AlertKind =
  | "publish_dead"
  | "publish_uncertain"
  | "reconciliation_unresolved"
  | "media_dead"
  | "analytics_dead"
  | "approval_email_failed"
  | "token_unhealthy"
  | "queue_stuck";

export type OperationalProblem = {
  fingerprint: string;
  kind: AlertKind;
  detail: string;
};

// Kinds in email order; each runbook reference points at OPERATIONS.md.
const KINDS: Record<AlertKind, { title: string; runbook: string }> = {
  publish_uncertain: {
    title: "Bizonytalan Meta-közzététel (META_DELIVERY_UNCERTAIN)",
    runbook:
      "Incident triage 5. lépés – ne indítsd újra vakon, a Meta már közzétehette.",
  },
  reconciliation_unresolved: {
    title: "Feloldatlan közzététel-egyeztetés",
    runbook:
      "Incident triage 5. lépés – token/API javítása után újraellenőrzés az Üzemeltetés részben.",
  },
  publish_dead: {
    title: "Végleg sikertelen közzétételi feladat (DEAD)",
    runbook: "Incident triage 4. lépés – publish_attempts hibakódja.",
  },
  media_dead: {
    title: "Végleg sikertelen médiafeldolgozás (DEAD)",
    runbook: "Incident triage 4. lépés – media_processing_jobs.last_error.",
  },
  queue_stuck: {
    title: "Elakadt feladatsor (5 percnél régebbi esedékes feladat)",
    runbook:
      "Incident triage 3. lépés – worker-szívverés, Redis és a dispatcher naplói.",
  },
  analytics_dead: {
    title: "Végleg sikertelen analitika-szinkron",
    runbook: "Incident triage 9. lépés.",
  },
  approval_email_failed: {
    title: "Jóváhagyási e-mail háromszor sikertelen",
    runbook: "Incident triage 6. lépés – SMTP/Resend beállítás.",
  },
  token_unhealthy: {
    title: "Nem egészséges közösségimédia-token",
    runbook: "A fiók újracsatlakoztatása az ügyfél Fiókok oldalán.",
  },
};

const QUEUE_STUCK_SECONDS = 300;

// The same definitions as operationalSummary, but across every organization:
// this is operator alerting, not a tenant view.
export async function collectOperationalProblems(): Promise<
  OperationalProblem[]
> {
  const scoped = await pool.query(
    `SELECT p.kind,p.entity_id,p.extra,o.id AS organization_id,
       o.name AS organization_name,c.id AS client_id,c.name AS client_name
     FROM (
       SELECT CASE WHEN last_error='META_DELIVERY_UNCERTAIN'
         THEN 'publish_uncertain' ELSE 'publish_dead' END AS kind,
         id AS entity_id,NULL::text AS extra,organization_id,client_id
       FROM publish_jobs WHERE status='DEAD'
       UNION ALL
       SELECT 'reconciliation_unresolved',id,NULL,organization_id,client_id
       FROM publish_reconciliation_jobs WHERE status='UNRESOLVED'
       UNION ALL
       SELECT 'media_dead',id,NULL,organization_id,client_id
       FROM media_processing_jobs WHERE status='DEAD'
       UNION ALL
       SELECT 'analytics_dead',id,NULL,organization_id,client_id
       FROM analytics_sync_jobs WHERE status='DEAD'
       UNION ALL
       SELECT 'approval_email_failed',id,NULL,organization_id,client_id
       FROM approval_automation_deliveries WHERE status='FAILED' AND attempts>=3
       UNION ALL
       SELECT 'token_unhealthy',id,platform,organization_id,client_id
       FROM social_accounts
       WHERE status='CONNECTED' AND token_health<>'HEALTHY' AND deleted_at IS NULL
     ) p
     JOIN organizations o ON o.id=p.organization_id
     JOIN clients c ON c.id=p.client_id
     ORDER BY o.name,c.name,p.entity_id`,
  );
  const problems: OperationalProblem[] = scoped.rows.map((row) => ({
    fingerprint: `${row.kind}:${row.entity_id}`,
    kind: row.kind,
    detail: `${row.organization_name} / ${row.client_name} (szervezet ${row.organization_id}, ügyfél ${row.client_id}) – ${row.extra ? `${row.extra} ` : ""}azonosító ${row.entity_id}`,
  }));
  const queue = await pool.query(
    `SELECT max(extract(epoch FROM now()-run_at)) AS oldest_due_seconds
     FROM (
       SELECT run_at FROM publish_jobs
       WHERE status IN ('PENDING','RETRY') AND run_at<=now()
       UNION ALL
       SELECT run_at FROM media_processing_jobs
       WHERE status IN ('PENDING','RETRY') AND run_at<=now()
     ) due`,
  );
  const oldest = Number(queue.rows[0]?.oldest_due_seconds) || 0;
  if (oldest > QUEUE_STUCK_SECONDS)
    problems.push({
      fingerprint: "queue_stuck",
      kind: "queue_stuck",
      detail: `a legrégebbi esedékes feladat ${Math.round(oldest / 60)} perce vár`,
    });
  return problems;
}

function groupProblems(
  problems: OperationalProblem[],
): OperationalAlertGroup[] {
  return (Object.keys(KINDS) as AlertKind[])
    .map((kind) => ({
      kind,
      ...KINDS[kind],
      items: problems.filter((problem) => problem.kind === kind),
    }))
    .filter((group) => group.items.length);
}

// Each distinct problem notifies once. A problem that disappears is marked
// resolved; if it comes back later it notifies again. All new problems of one
// run go out in a single email.
export async function runAlertChecks() {
  const problems = await collectOperationalProblems();
  const fingerprints = problems.map((problem) => problem.fingerprint);
  for (const problem of problems)
    await pool.query(
      `INSERT INTO operational_alerts(fingerprint,kind) VALUES($1,$2)
       ON CONFLICT(fingerprint) DO UPDATE SET
         last_seen_at=now(),
         first_seen_at=CASE WHEN operational_alerts.resolved_at IS NULL
           THEN operational_alerts.first_seen_at ELSE now() END,
         notified_at=CASE WHEN operational_alerts.resolved_at IS NULL
           THEN operational_alerts.notified_at END,
         resolved_at=NULL`,
      [problem.fingerprint, problem.kind],
    );
  const resolved = await pool.query(
    `UPDATE operational_alerts SET resolved_at=now()
     WHERE resolved_at IS NULL AND NOT (fingerprint=ANY($1::text[]))
     RETURNING fingerprint`,
    [fingerprints],
  );
  // Claiming before sending keeps two worker instances from both emailing.
  const claimed = await pool.query(
    `UPDATE operational_alerts SET notified_at=now()
     WHERE resolved_at IS NULL AND notified_at IS NULL
     RETURNING fingerprint`,
  );
  const claimedSet = new Set(
    claimed.rows.map((row) => row.fingerprint as string),
  );
  const fresh = problems.filter((problem) =>
    claimedSet.has(problem.fingerprint),
  );
  const summary = {
    open: problems.length,
    new: fresh.length,
    resolved: resolved.rows.length,
    emailed: false,
  };
  if (!fresh.length) return summary;
  const groups = groupProblems(fresh);
  for (const group of groups)
    Sentry.captureMessage(`Operational alert: ${group.kind}`, {
      level: "warning",
      fingerprint: ["operational-alert", group.kind],
      tags: { kind: group.kind },
      extra: { count: group.items.length },
    });
  const recipient = process.env.ALERT_EMAIL;
  if (!recipient) {
    console.warn(
      JSON.stringify({
        event: "operational_alert_email_skipped",
        code: "ALERT_EMAIL_MISSING",
        alerts: fresh.length,
      }),
    );
    return summary;
  }
  const mail = operationalAlertMail(groups);
  try {
    await sendMail(recipient, mail.subject, mail.text);
  } catch {
    // Release the claim so the next run retries the email.
    await pool.query(
      `UPDATE operational_alerts SET notified_at=NULL
       WHERE fingerprint=ANY($1::text[])`,
      [[...claimedSet]],
    );
    console.error(
      JSON.stringify({
        event: "operational_alert_email_failed",
        code: "ALERT_EMAIL_FAILED",
        alerts: fresh.length,
      }),
    );
    return summary;
  }
  return { ...summary, emailed: true };
}
