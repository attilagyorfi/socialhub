"use client";
import { useCallback, useEffect, useState } from "react";
import { CalendarCheck, Copy } from "lucide-react";
import { DateTime } from "luxon";
import { intlLocale, useT, type MessageKey } from "../i18n";
import { formatDate } from "./types";

type Summary = {
  total: number;
  approved: number;
  changesRequested: number;
  pending: number;
  unavailable: number;
};
type Bundle = {
  id: string;
  period_start: string;
  period_end: string;
  expires_at: string;
  revoked_at: string | null;
  state: "ACTIVE" | "EXPIRED" | "REVOKED";
  summary: Summary;
};
type Created = {
  url: string;
  items: number;
  skipped: number;
  skippedReasons: Record<string, number>;
};

const errorKeys: Record<string, MessageKey> = {
  BUNDLE_EMPTY: "approve.bundles.emptyPeriod",
  BUNDLE_TOO_LARGE: "approve.bundles.tooLarge",
  INVALID_PERIOD: "approve.bundles.invalidPeriod",
};

// Next month in the user's time zone, as the default period.
function nextMonth(timeZone: string) {
  const start = DateTime.now().setZone(timeZone).plus({ months: 1 });
  return {
    from: start.startOf("month").toISODate()!,
    to: start.endOf("month").toISODate()!,
  };
}

// Monthly approval links of the selected client. The link is shown once,
// right after creation; afterwards only its progress is listed.
export function ApprovalBundles({
  clientId,
  timeZone,
}: {
  clientId: string;
  timeZone: string;
}) {
  const { t } = useT();
  const [bundles, setBundles] = useState<Bundle[]>([]);
  const [range, setRange] = useState(() => nextMonth(timeZone));
  const [expiresInDays, setExpiresInDays] = useState(14);
  const [created, setCreated] = useState<Created | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);

  const load = useCallback(async () => {
    const response = await fetch(
      `/api/approval-bundles?clientId=${encodeURIComponent(clientId)}`,
    );
    if (!response.ok) throw new Error("load failed");
    setBundles((await response.json()).bundles);
  }, [clientId]);

  useEffect(() => {
    setCreated(null);
    load().catch(() => setError("approve.bundles.failed"));
  }, [load]);

  async function send(fields: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/approval-bundles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId, ...fields }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(errorKeys[result.code] ?? "approve.bundles.failed");
        return;
      }
      await load();
      return result;
    } catch {
      setError("approve.bundles.failed");
    } finally {
      setBusy(false);
    }
  }

  const day = (value: string) =>
    DateTime.fromISO(value, { zone: timeZone }).startOf("day");
  const dateOnly = (value: string) =>
    new Intl.DateTimeFormat(intlLocale(), {
      timeZone,
      year: "numeric",
      month: "short",
      day: "numeric",
    }).format(new Date(value));
  const validRange =
    range.from && range.to && day(range.to) >= day(range.from);

  return (
    <section className="panel">
      <div className="panel-title">
        <div>
          <h2>{t("approve.bundles.title")}</h2>
          <span className="muted">{t("approve.bundles.subtitle")}</span>
        </div>
        <CalendarCheck size={20} />
      </div>
      <form
        className="inline-form"
        onSubmit={async (event) => {
          event.preventDefault();
          const result = await send({
            action: "create",
            periodStart: day(range.from).toISO(),
            // The end date is inclusive in the form, exclusive on the server.
            periodEnd: day(range.to).plus({ days: 1 }).toISO(),
            expiresInDays,
          });
          if (result?.url) {
            setCreated(result);
            setCopied(false);
          }
        }}
      >
        <label>
          {t("approve.bundles.from")}
          <input
            type="date"
            required
            value={range.from}
            onChange={(event) =>
              setRange({ ...range, from: event.target.value })
            }
          />
        </label>
        <label>
          {t("approve.bundles.to")}
          <input
            type="date"
            required
            value={range.to}
            onChange={(event) => setRange({ ...range, to: event.target.value })}
          />
        </label>
        <label>
          {t("approve.bundles.expiresIn")}
          <input
            type="number"
            min={1}
            max={30}
            required
            value={expiresInDays}
            onChange={(event) => setExpiresInDays(Number(event.target.value))}
          />
        </label>
        <button className="primary" disabled={busy || !validRange}>
          {t("approve.bundles.create")}
        </button>
      </form>
      {created && (
        <div className="notice invitation-link" role="status">
          <span>
            {t("approve.bundles.created", { items: created.items })}{" "}
            {created.skipped > 0 &&
              t("approve.bundles.skipped", {
                count: created.skipped,
                reasons: Object.entries(created.skippedReasons)
                  .filter(([, count]) => count > 0)
                  .map(([reason, count]) =>
                    t(`approve.bundles.reason.${reason}` as MessageKey, {
                      count,
                    }),
                  )
                  .join(", "),
              })}
            <br />
            <strong>{t("approve.bundles.linkWarning")}</strong>{" "}
            <code>{created.url}</code>
          </span>
          <button
            type="button"
            aria-label={t("approve.bundles.copy")}
            onClick={() =>
              navigator.clipboard
                .writeText(created.url)
                .then(() => setCopied(true))
                .catch(() => {})
            }
          >
            <Copy size={15} />{" "}
            {t(copied ? "approve.bundles.copied" : "approve.bundles.copy")}
          </button>
          <button type="button" onClick={() => setCreated(null)}>
            {t("common.action.close")}
          </button>
        </div>
      )}
      {error && (
        <div className="notice invitation-link" role="alert">
          {t(error)}
        </div>
      )}
      {bundles.map((bundle) => (
        <div className="pending-invite" key={bundle.id}>
          <CalendarCheck size={18} />
          <span>
            <strong>
              {t("approve.bundles.period", {
                from: dateOnly(bundle.period_start),
                // period_end is exclusive.
                to: dateOnly(
                  new Date(
                    new Date(bundle.period_end).getTime() - 1,
                  ).toISOString(),
                ),
              })}{" "}
              · {t(`approve.bundles.state.${bundle.state}` as MessageKey)}
            </strong>
            <small>
              {t("approve.bundles.status", {
                approved: bundle.summary.approved,
                total: bundle.summary.total,
                changes: bundle.summary.changesRequested,
                pending: bundle.summary.pending,
                unavailable: bundle.summary.unavailable,
              })}
              {bundle.state === "ACTIVE" &&
                ` · ${t("approve.bundles.expires", {
                  date: formatDate(bundle.expires_at, timeZone),
                })}`}
            </small>
          </span>
          {bundle.state === "ACTIVE" && (
            <button
              className="danger-button"
              disabled={busy}
              onClick={() => {
                if (window.confirm(t("approve.bundles.revokeConfirm")))
                  send({ action: "revoke", id: bundle.id }).catch(() => {});
              }}
            >
              {t("approve.bundles.revoke")}
            </button>
          )}
        </div>
      ))}
      {!bundles.length && (
        <div className="empty compact">{t("approve.bundles.empty")}</div>
      )}
    </section>
  );
}
