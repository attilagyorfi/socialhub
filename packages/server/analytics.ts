import { pool } from "../db";
import type { Platform } from "../core/domain";
import { AppError } from "../core/security";
import type { Context } from "./context";

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_ANALYTICS_DAYS = 366;
const metricKeys = ["followers", "reach", "impressions", "engagement"] as const;
type Metric = (typeof metricKeys)[number];
type DailyRow = {
  day: string;
  platform: Platform;
  provider: string;
  followers: number | string;
  reach: number | string;
  impressions: number | string;
  engagement: number | string;
};
type Totals = Record<Metric, number>;

function isoDay(date: Date) {
  return date.toISOString().slice(0, 10);
}

export function analyticsRange(fromValue: string, toValue: string) {
  const from = new Date(`${fromValue}T00:00:00.000Z`);
  const through = new Date(`${toValue}T00:00:00.000Z`);
  if (
    !Number.isFinite(from.getTime()) ||
    !Number.isFinite(through.getTime()) ||
    through < from
  )
    throw new AppError(
      422,
      "INVALID_RANGE",
      "Choose a valid analytics date range.",
    );
  const days = Math.round((through.getTime() - from.getTime()) / DAY_MS) + 1;
  if (days > MAX_ANALYTICS_DAYS)
    throw new AppError(
      422,
      "INVALID_RANGE",
      "Choose an analytics range of 366 days or less.",
    );
  const toExclusive = new Date(through.getTime() + DAY_MS);
  const previousToExclusive = from;
  const previousFrom = new Date(from.getTime() - days * DAY_MS);
  return {
    from,
    toExclusive,
    previousFrom,
    previousToExclusive,
    days,
    range: { from: isoDay(from), to: isoDay(through) },
    previousRange: {
      from: isoDay(previousFrom),
      to: isoDay(new Date(previousToExclusive.getTime() - DAY_MS)),
    },
  };
}

function emptyTotals(): Totals {
  return { followers: 0, reach: 0, impressions: 0, engagement: 0 };
}

function normalizedRow(row: DailyRow) {
  return {
    ...row,
    day: String(row.day).slice(0, 10),
    followers: Number(row.followers) || 0,
    reach: Number(row.reach) || 0,
    impressions: Number(row.impressions) || 0,
    engagement: Number(row.engagement) || 0,
  };
}

export function summarizeAnalyticsRows(rows: DailyRow[]) {
  const normalized = rows.map(normalizedRow);
  const totals = emptyTotals();
  const latestFollowers = new Map<string, { day: string; value: number }>();
  for (const row of normalized) {
    totals.reach += row.reach;
    totals.impressions += row.impressions;
    totals.engagement += row.engagement;
    const key = `${row.platform}:${row.provider}`;
    const current = latestFollowers.get(key);
    if (!current || row.day > current.day)
      latestFollowers.set(key, { day: row.day, value: row.followers });
  }
  totals.followers = [...latestFollowers.values()].reduce(
    (sum, item) => sum + item.value,
    0,
  );
  return totals;
}

function changePercent(current: number, previous: number) {
  if (!previous) return current ? null : 0;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

function buildSummary(current: Totals, previous: Totals) {
  return Object.fromEntries(
    metricKeys.map((metric) => [
      metric,
      {
        value: current[metric],
        previous: previous[metric],
        changePercent: changePercent(current[metric], previous[metric]),
      },
    ]),
  );
}

function aggregateSeries(rows: DailyRow[]) {
  const days = new Map<string, Totals>();
  for (const raw of rows) {
    const row = normalizedRow(raw);
    const current = days.get(row.day) ?? emptyTotals();
    for (const metric of metricKeys) current[metric] += row[metric];
    days.set(row.day, current);
  }
  return [...days.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([day, metrics]) => ({ day, ...metrics }));
}

function aggregatePlatforms(rows: DailyRow[]) {
  const platforms = new Map<Platform, DailyRow[]>();
  for (const row of rows) {
    const current = platforms.get(row.platform) ?? [];
    current.push(row);
    platforms.set(row.platform, current);
  }
  return [...platforms.entries()]
    .map(([platform, platformRows]) => ({
      platform,
      ...summarizeAnalyticsRows(platformRows),
    }))
    .sort((left, right) => right.engagement - left.engagement);
}

export async function getAnalytics(
  c: Context,
  input: { from: string; to: string; platform?: Platform },
) {
  const range = analyticsRange(input.from, input.to);
  const values: unknown[] = [
    c.organizationId,
    c.clientId,
    range.previousFrom,
    range.toExclusive,
  ];
  const platformCondition = input.platform
    ? (values.push(input.platform), `AND a.platform=$${values.length}`)
    : "";
  const topValues: unknown[] = [
    c.organizationId,
    c.clientId,
    range.from,
    range.toExclusive,
  ];
  const topPlatformCondition = input.platform
    ? (topValues.push(input.platform), `AND a.platform=$${topValues.length}`)
    : "";
  const [dailyResult, topResult] = await Promise.all([
    pool.query(
      `SELECT ad.day::text,a.platform,ad.provider,
       sum(coalesce((ad.normalized->>'followers')::numeric,0))::float8 AS followers,
       sum(coalesce((ad.normalized->>'reach')::numeric,0))::float8 AS reach,
       sum(coalesce((ad.normalized->>'impressions')::numeric,0))::float8 AS impressions,
       sum(coalesce((ad.normalized->>'engagement')::numeric,0))::float8 AS engagement
       FROM analytics_daily ad
       JOIN social_accounts a ON a.id=ad.social_account_id
       WHERE ad.organization_id=$1 AND ad.client_id=$2
         AND ad.day >= $3::date AND ad.day < $4::date
         AND a.deleted_at IS NULL ${platformCondition}
       GROUP BY ad.day,a.platform,ad.provider
       ORDER BY ad.day,a.platform,ad.provider`,
      values,
    ),
    pool.query(
      `WITH latest_metrics AS (
         SELECT DISTINCT ON (pm.target_id)
           pm.target_id,pm.provider,pm.normalized,pm.captured_at
         FROM post_metrics pm
         WHERE pm.organization_id=$1 AND pm.client_id=$2
         ORDER BY pm.target_id,pm.captured_at DESC,pm.id DESC
       )
       SELECT p.id,p.caption,max(t.published_at) AS published_at,
        array_agg(DISTINCT a.platform ORDER BY a.platform) AS platforms,
        array_agg(DISTINCT lm.provider ORDER BY lm.provider) AS providers,
        sum(coalesce((lm.normalized->>'likes')::numeric,0))::float8 AS likes,
        sum(coalesce((lm.normalized->>'comments')::numeric,0))::float8 AS comments,
        sum(coalesce((lm.normalized->>'shares')::numeric,0))::float8 AS shares,
        sum(coalesce((lm.normalized->>'views')::numeric,0))::float8 AS views,
        sum(coalesce((lm.normalized->>'reach')::numeric,0))::float8 AS reach,
        sum(coalesce((lm.normalized->>'impressions')::numeric,0))::float8 AS impressions,
        sum(
          coalesce((lm.normalized->>'likes')::numeric,0)+
          coalesce((lm.normalized->>'comments')::numeric,0)+
          coalesce((lm.normalized->>'shares')::numeric,0)
        )::float8 AS engagement
       FROM posts p
       JOIN post_targets t ON t.post_id=p.id
       JOIN social_accounts a ON a.id=t.social_account_id
       JOIN latest_metrics lm ON lm.target_id=t.id
       WHERE p.organization_id=$1 AND p.client_id=$2 AND p.deleted_at IS NULL
         AND t.status='PUBLISHED' AND t.published_at >= $3
         AND t.published_at < $4 ${topPlatformCondition}
       GROUP BY p.id,p.caption
       ORDER BY engagement DESC,impressions DESC,p.id
       LIMIT 10`,
      topValues,
    ),
  ]);
  const rows = dailyResult.rows as DailyRow[];
  const currentRows = rows.filter(
    (row) => String(row.day).slice(0, 10) >= range.range.from,
  );
  const previousRows = rows.filter(
    (row) => String(row.day).slice(0, 10) < range.range.from,
  );
  const sources = [
    ...new Set([
      ...rows.map((row) => row.provider),
      ...topResult.rows.flatMap((row) => row.providers as string[]),
    ]),
  ].sort();
  return {
    range: range.range,
    previousRange: range.previousRange,
    summary: buildSummary(
      summarizeAnalyticsRows(currentRows),
      summarizeAnalyticsRows(previousRows),
    ),
    series: aggregateSeries(currentRows),
    platforms: aggregatePlatforms(currentRows),
    topContent: topResult.rows,
    sources,
    mockOnly:
      !!sources.length && sources.every((source) => source.startsWith("mock:")),
  };
}
