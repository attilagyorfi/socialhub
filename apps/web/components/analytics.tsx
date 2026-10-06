"use client";

import { useEffect, useState } from "react";
import { Network } from "./types";
import {
  apiError,
  currentLocale,
  intlLocale,
  useT,
  type MessageKey,
  type Vars,
} from "../i18n";

const metricKeys = ["followers", "reach", "impressions", "engagement"] as const;
type Metric = (typeof metricKeys)[number];
type MetricValue = {
  value: number;
  previous: number;
  changePercent: number | null;
};
type AnalyticsResult = {
  range: { from: string; to: string };
  previousRange: { from: string; to: string };
  summary: Record<Metric, MetricValue>;
  series: ({ day: string } & Record<Metric, number>)[];
  platforms: ({ platform: string } & Record<Metric, number>)[];
  topContent: {
    id: string;
    caption: string;
    published_at: string;
    platforms: string[];
    likes: number;
    comments: number;
    shares: number;
    views: number;
    reach: number;
    impressions: number;
    engagement: number;
  }[];
  sources: string[];
  mockOnly: boolean;
};

function isoDay(date: Date) {
  return date.toISOString().slice(0, 10);
}

function daysAgo(days: number) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return isoDay(date);
}

// en-GB writes compact thousands as "2.1k"; plain "en" keeps "2.1K".
function number(value: number) {
  const locale = currentLocale() === "hu" ? intlLocale() : "en";
  return new Intl.NumberFormat(locale, { notation: "compact" }).format(value);
}

function comparison(
  value: MetricValue,
  t: (key: MessageKey, vars?: Vars) => string,
) {
  if (value.changePercent === null) return t("analytics.comparison.none");
  if (!value.changePercent) return t("analytics.comparison.same");
  return t("analytics.comparison.change", {
    change: `${value.changePercent > 0 ? "+" : ""}${value.changePercent}`,
  });
}

export function Analytics({
  clientId,
  refreshKey,
  onOpen,
  onError,
}: {
  clientId: string;
  refreshKey: number;
  onOpen: (postId: string) => void;
  onError: (message: string) => void;
}) {
  const { t } = useT();
  const [metric, setMetric] = useState<Metric>("reach");
  const [platform, setPlatform] = useState("all");
  const [from, setFrom] = useState(() => daysAgo(29));
  const [to, setTo] = useState(() => daysAgo(0));
  const [result, setResult] = useState<AnalyticsResult>();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!from || !to || from > to) return;
    const controller = new AbortController();
    const params = new URLSearchParams({
      clientId,
      from,
      to,
      ...(platform !== "all" ? { platform } : {}),
    });
    setLoading(true);
    fetch(`/api/analytics?${params}`, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(apiError(body));
        setResult(body);
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError")
          return;
        onError(
          error instanceof Error ? error.message : t("analytics.error.load"),
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [clientId, from, onError, platform, refreshKey, t, to]);

  const points = result?.series ?? [];
  const max = Math.max(1, ...points.map((point) => point[metric]));
  const labelEvery = Math.max(1, Math.ceil(points.length / 12));
  const setPreset = (days: number) => {
    setFrom(daysAgo(days - 1));
    setTo(daysAgo(0));
  };

  return (
    <>
      <div className="notice">
        {result?.mockOnly
          ? t("analytics.notice.mock")
          : t("analytics.notice.real")}
        {t("analytics.notice.caveat")}
      </div>
      <section className="panel analytics-controls" aria-busy={loading}>
        <div className="panel-title">
          <div>
            <h2>{t("analytics.title.overview")}</h2>
            <span className="muted">
              {result
                ? `${result.range.from} – ${result.range.to}`
                : t("analytics.loading")}
            </span>
          </div>
          <div
            className="analytics-presets"
            aria-label={t("analytics.presets")}
          >
            {[7, 30, 90].map((days) => (
              <button key={days} onClick={() => setPreset(days)}>
                {t("analytics.preset.days", { days })}
              </button>
            ))}
          </div>
        </div>
        <div className="calendar-filters">
          <select
            aria-label={t("analytics.filter.network")}
            value={platform}
            onChange={(event) => setPlatform(event.target.value)}
          >
            <option value="all">{t("analytics.filter.allNetworks")}</option>
            {["facebook", "instagram", "linkedin", "tiktok", "google"].map(
              (value) => (
                <option key={value} value={value}>
                  {t(`common.network.${value}` as MessageKey)}
                </option>
              ),
            )}
          </select>
          <label>
            {t("analytics.from")}
            <input
              aria-label={t("analytics.from.aria")}
              type="date"
              value={from}
              max={to}
              onChange={(event) => setFrom(event.target.value)}
            />
          </label>
          <label>
            {t("analytics.to")}
            <input
              aria-label={t("analytics.to.aria")}
              type="date"
              value={to}
              min={from}
              max={daysAgo(0)}
              onChange={(event) => setTo(event.target.value)}
            />
          </label>
        </div>
      </section>

      <div className="analytics-kpis">
        {metricKeys.map((key) => {
          const value = result?.summary[key];
          return (
            <section className="analytics-kpi" key={key}>
              <span>{t(`analytics.metric.${key}`)}</span>
              <strong>{value ? number(value.value) : "—"}</strong>
              <small
                className={
                  value?.changePercent && value.changePercent < 0
                    ? "negative"
                    : ""
                }
              >
                {value ? comparison(value, t) : t("analytics.loadingShort")}
              </small>
            </section>
          );
        })}
      </div>

      <section className="panel analytics-chart-panel">
        <div className="panel-title">
          <div>
            <h2>{t("analytics.title.trend")}</h2>
            <span className="muted">
              {t("analytics.comparedWith", {
                from: result?.previousRange.from ?? "…",
                to: result?.previousRange.to ?? "…",
              })}
            </span>
          </div>
          <select
            aria-label={t("analytics.metricSelect")}
            value={metric}
            onChange={(event) => setMetric(event.target.value as Metric)}
          >
            {metricKeys.map((key) => (
              <option key={key} value={key}>
                {t(`analytics.metric.${key}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="analytics-chart-scroll">
          <div
            className="chart"
            role="img"
            aria-label={t("analytics.chart.aria", {
              metric: t(`analytics.metric.${metric}`),
              points: points
                .map((point) => `${point.day}: ${point[metric]}`)
                .join(", "),
            })}
            style={{ minWidth: `${Math.max(680, points.length * 18)}px` }}
          >
            <div className="chart-labels">
              <span>{number(max)}</span>
              <span>{number(Math.round(max / 2))}</span>
              <span>0</span>
            </div>
            <div className="bars">
              {points.map((point, index) => (
                <div
                  key={point.day}
                  className="bar-column"
                  title={`${point.day}: ${point[metric]}`}
                >
                  <div
                    className="bar"
                    style={{
                      height: `${Math.max(1, (point[metric] / max) * 100)}%`,
                    }}
                  />
                  {index % labelEvery === 0 && (
                    <small>{point.day.slice(5)}</small>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
        {!loading && !points.length && (
          <div className="empty compact">{t("analytics.chart.empty")}</div>
        )}
      </section>

      <div className="analytics-grid">
        <section className="panel">
          <div className="panel-title">
            <h2>{t("analytics.title.networks")}</h2>
            <span className="muted">{t("analytics.currentPeriod")}</span>
          </div>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>{t("analytics.column.network")}</th>
                  <th>{t("analytics.metric.reach")}</th>
                  <th>{t("analytics.metric.impressions")}</th>
                  <th>{t("analytics.metric.engagement")}</th>
                </tr>
              </thead>
              <tbody>
                {result?.platforms.map((row) => (
                  <tr key={row.platform}>
                    <td>
                      <Network platform={row.platform} />
                    </td>
                    <td>{number(row.reach)}</td>
                    <td>{number(row.impressions)}</td>
                    <td>{number(row.engagement)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!loading && !result?.platforms.length && (
            <div className="empty compact">{t("analytics.networks.empty")}</div>
          )}
        </section>

        <section className="panel">
          <div className="panel-title">
            <h2>{t("analytics.title.top")}</h2>
            <span className="muted">{t("analytics.top.ranked")}</span>
          </div>
          <div className="top-content-list">
            {result?.topContent.map((post, index) => (
              <button key={post.id} onClick={() => onOpen(post.id)}>
                <span className="top-content-rank">{index + 1}</span>
                <span className="top-content-copy">
                  <strong>
                    {post.caption.slice(0, 90) || t("analytics.mediaPost")}
                  </strong>
                  <small>
                    {post.platforms
                      .map((name) => t(`common.network.${name}` as MessageKey))
                      .join(" · ")}{" "}
                    · {number(post.impressions)}
                    {t("analytics.top.impressions")}
                  </small>
                </span>
                <span className="top-content-score">
                  {number(post.engagement)}
                  <small>{t("analytics.top.interactions")}</small>
                </span>
              </button>
            ))}
          </div>
          {!loading && !result?.topContent.length && (
            <div className="empty compact">{t("analytics.top.empty")}</div>
          )}
        </section>
      </div>
    </>
  );
}
