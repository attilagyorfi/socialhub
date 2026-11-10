import { pool } from "../db";
import { AppError } from "../core/security";
import type { ApiKeyContext } from "./api-keys";
import { uuid } from "./validation";

// Longest range, in days including both ends, one metrics request may cover.
export const maxMetricsRangeDays = 92;
const dayMs = 86_400_000;

const invalidQuery = (message: string) =>
  new AppError(400, "INVALID_QUERY", message);

// Parses a YYYY-MM-DD calendar day as midnight UTC; rejects other formats and
// days that do not exist (e.g. 2026-02-30).
function parseDay(name: string, value: string | null) {
  if (!value) throw invalidQuery(`${name}: Required (YYYY-MM-DD).`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value))
    throw invalidQuery(`${name}: Use the YYYY-MM-DD format.`);
  const time = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(time) || new Date(time).toISOString().slice(0, 10) !== value)
    throw invalidQuery(`${name}: Not a valid date.`);
  return time;
}

export function parseMetricsRange(params: URLSearchParams) {
  const from = params.get("from");
  const to = params.get("to");
  const fromTime = parseDay("from", from);
  const toTime = parseDay("to", to);
  if (fromTime > toTime) throw invalidQuery("from must not be after to.");
  if ((toTime - fromTime) / dayMs + 1 > maxMetricsRangeDays)
    throw invalidQuery(
      `The range can cover at most ${maxMetricsRangeDays} days.`,
    );
  return {
    from: from!,
    to: to!,
    // Post metrics captured on these UTC days: [from 00:00, to+1 00:00).
    capturedFrom: new Date(fromTime).toISOString(),
    capturedBefore: new Date(toTime + dayMs).toISOString(),
  };
}

const clientNotFound = () =>
  new AppError(404, "NOT_FOUND", "Client not found.");

const iso = (value: unknown) =>
  value instanceof Date
    ? value.toISOString()
    : new Date(String(value)).toISOString();

type AccountMetrics = {
  social_account_id: string;
  provider: string;
  days: { day: string; metrics: Record<string, unknown> }[];
};

// GET /api/v1/clients/{id}/metrics. Reads only the normalized metrics the
// analytics sync has already stored; it never calls a provider or queues a
// sync. Every query is scoped to the key's organization and this client.
export async function getClientMetrics(
  key: ApiKeyContext,
  clientId: string,
  params: URLSearchParams,
) {
  const range = parseMetricsRange(params);
  if (!uuid.safeParse(clientId).success) throw clientNotFound();
  const client = await pool.query(
    "SELECT 1 FROM clients WHERE organization_id=$1 AND id=$2 AND deleted_at IS NULL",
    [key.organizationId, clientId],
  );
  if (!client.rows.length) throw clientNotFound();

  const daily = await pool.query(
    `SELECT social_account_id,provider,to_char(day,'YYYY-MM-DD') AS day,normalized
     FROM analytics_daily
     WHERE organization_id=$1 AND client_id=$2 AND day BETWEEN $3::date AND $4::date
     ORDER BY social_account_id,day`,
    [key.organizationId, clientId, range.from, range.to],
  );
  const accounts: AccountMetrics[] = [];
  for (const row of daily.rows) {
    const id = String(row.social_account_id);
    let account = accounts.at(-1);
    if (account?.social_account_id !== id) {
      account = { social_account_id: id, provider: row.provider, days: [] };
      accounts.push(account);
    }
    account.days.push({ day: String(row.day), metrics: row.normalized });
  }

  // The latest capture per target within the range.
  const latest = await pool.query(
    `SELECT * FROM (
       SELECT DISTINCT ON (m.target_id) t.post_id,m.target_id,m.provider,m.captured_at,m.normalized
       FROM post_metrics m
       JOIN post_targets t ON t.organization_id=m.organization_id
         AND t.client_id=m.client_id AND t.id=m.target_id
       JOIN posts p ON p.organization_id=t.organization_id
         AND p.client_id=t.client_id AND p.id=t.post_id AND p.deleted_at IS NULL
       WHERE m.organization_id=$1 AND m.client_id=$2
         AND m.captured_at>=$3::timestamptz AND m.captured_at<$4::timestamptz
       ORDER BY m.target_id,m.captured_at DESC,m.id DESC
     ) latest ORDER BY post_id,target_id`,
    [key.organizationId, clientId, range.capturedFrom, range.capturedBefore],
  );

  return {
    client_id: clientId,
    from: range.from,
    to: range.to,
    accounts,
    posts: latest.rows.map((row) => ({
      post_id: String(row.post_id),
      target_id: String(row.target_id),
      provider: String(row.provider),
      captured_at: iso(row.captured_at),
      metrics: row.normalized as Record<string, unknown>,
    })),
  };
}
