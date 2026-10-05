"use client";

import { useEffect, useState } from "react";
import { Network } from "./types";

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

function number(value: number) {
  return new Intl.NumberFormat("en", { notation: "compact" }).format(value);
}

function comparison(value: MetricValue) {
  if (value.changePercent === null) return "No previous baseline";
  if (!value.changePercent) return "No change";
  return `${value.changePercent > 0 ? "+" : ""}${value.changePercent}% vs previous period`;
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
        if (!response.ok)
          throw new Error(body.error ?? "Unable to load analytics.");
        setResult(body);
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError")
          return;
        onError(
          error instanceof Error ? error.message : "Unable to load analytics.",
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [clientId, from, onError, platform, refreshKey, to]);

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
          ? "Demonstration data from mock providers. "
          : "Metrics retain their provider source. "}
        Reach is summed per account and is not a deduplicated audience.
        Engagement definitions may differ by network.
      </div>
      <section className="panel analytics-controls" aria-busy={loading}>
        <div className="panel-title">
          <div>
            <h2>Performance overview</h2>
            <span className="muted">
              {result
                ? `${result.range.from} – ${result.range.to}`
                : "Loading analytics…"}
            </span>
          </div>
          <div className="analytics-presets" aria-label="Date range presets">
            {[7, 30, 90].map((days) => (
              <button key={days} onClick={() => setPreset(days)}>
                {days} days
              </button>
            ))}
          </div>
        </div>
        <div className="calendar-filters">
          <select
            aria-label="Analytics network"
            value={platform}
            onChange={(event) => setPlatform(event.target.value)}
          >
            <option value="all">All networks</option>
            {["facebook", "instagram", "linkedin", "tiktok", "google"].map(
              (value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ),
            )}
          </select>
          <label>
            From
            <input
              aria-label="Analytics from"
              type="date"
              value={from}
              max={to}
              onChange={(event) => setFrom(event.target.value)}
            />
          </label>
          <label>
            To
            <input
              aria-label="Analytics to"
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
              <span>{key}</span>
              <strong>{value ? number(value.value) : "—"}</strong>
              <small
                className={
                  value?.changePercent && value.changePercent < 0
                    ? "negative"
                    : ""
                }
              >
                {value ? comparison(value) : "Loading…"}
              </small>
            </section>
          );
        })}
      </div>

      <section className="panel analytics-chart-panel">
        <div className="panel-title">
          <div>
            <h2>Daily trend</h2>
            <span className="muted">
              Compared with {result?.previousRange.from ?? "…"} –{" "}
              {result?.previousRange.to ?? "…"}
            </span>
          </div>
          <select
            aria-label="Analytics metric"
            value={metric}
            onChange={(event) => setMetric(event.target.value as Metric)}
          >
            {metricKeys.map((key) => (
              <option key={key} value={key}>
                {key}
              </option>
            ))}
          </select>
        </div>
        <div className="analytics-chart-scroll">
          <div
            className="chart"
            role="img"
            aria-label={`${metric} by day. ${points
              .map((point) => `${point.day}: ${point[metric]}`)
              .join(", ")}`}
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
          <div className="empty compact">
            No account metrics were captured in this period.
          </div>
        )}
      </section>

      <div className="analytics-grid">
        <section className="panel">
          <div className="panel-title">
            <h2>Network breakdown</h2>
            <span className="muted">Current period</span>
          </div>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Network</th>
                  <th>Reach</th>
                  <th>Impressions</th>
                  <th>Engagement</th>
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
            <div className="empty compact">No network data in this period.</div>
          )}
        </section>

        <section className="panel">
          <div className="panel-title">
            <h2>Top content</h2>
            <span className="muted">Ranked by interactions</span>
          </div>
          <div className="top-content-list">
            {result?.topContent.map((post, index) => (
              <button key={post.id} onClick={() => onOpen(post.id)}>
                <span className="top-content-rank">{index + 1}</span>
                <span className="top-content-copy">
                  <strong>{post.caption.slice(0, 90) || "Media post"}</strong>
                  <small>
                    {post.platforms.join(" · ")} · {number(post.impressions)}
                    {" impressions"}
                  </small>
                </span>
                <span className="top-content-score">
                  {number(post.engagement)}
                  <small>interactions</small>
                </span>
              </button>
            ))}
          </div>
          {!loading && !result?.topContent.length && (
            <div className="empty compact">
              No published posts with metrics in this period.
            </div>
          )}
        </section>
      </div>
    </>
  );
}
