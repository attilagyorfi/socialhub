"use client";
import { useEffect, useState } from "react";
import { DateTime } from "luxon";
import { Layers } from "lucide-react";
import { MediaThumb } from "./media";
import { apiError, intlLocale, useT } from "../i18n";

type GridItem = {
  postId: string;
  state: "published" | "planned";
  at: string;
  caption: string;
  mediaCount: number;
  cover: { id: string; name: string; mime_type: string } | null;
};

// Instagram profile preview next to the calendar: published and planned
// posts, newest first, three per row like the profile. Built from stored
// data only; the server makes no call to Instagram for it.
export function InstagramGrid({
  clientId,
  timeZone,
  refreshKey,
}: {
  clientId: string;
  timeZone: string;
  refreshKey: number;
}) {
  const { t, locale } = useT();
  const [data, setData] = useState<{
    hasInstagram: boolean;
    items: GridItem[];
  }>();
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    fetch(`/api/calendar/grid?${new URLSearchParams({ clientId })}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(apiError(body));
        setData(body);
      })
      .catch((reason) => {
        if (reason instanceof DOMException && reason.name === "AbortError")
          return;
        setError(
          reason instanceof Error ? reason.message : t("calendar.grid.error"),
        );
      });
    return () => controller.abort();
  }, [clientId, refreshKey, t]);

  return (
    <section className="panel instagram-grid-panel" aria-busy={!data && !error}>
      <div className="panel-title">
        <div>
          <h2>{t("calendar.grid.title")}</h2>
          <p className="panel-note">{t("calendar.grid.subtitle")}</p>
        </div>
      </div>
      {error ? (
        <div className="empty compact">{error}</div>
      ) : !data ? (
        <div className="empty compact">{t("calendar.grid.loading")}</div>
      ) : !data.hasInstagram ? (
        <div className="empty compact">{t("calendar.grid.noInstagram")}</div>
      ) : !data.items.length ? (
        <div className="empty compact">{t("calendar.grid.empty")}</div>
      ) : (
        <ul className="instagram-grid">
          {data.items.map((item) => (
            <li
              key={`${item.postId}-${item.at}`}
              className={`instagram-cell ${item.state}`}
              title={`${DateTime.fromISO(item.at)
                .setZone(timeZone)
                .setLocale(intlLocale(locale))
                .toLocaleString(DateTime.DATETIME_MED)} · ${item.caption}`}
            >
              {item.cover ? (
                <MediaThumb clientId={clientId} asset={item.cover} />
              ) : (
                <span className="instagram-placeholder">
                  {t("calendar.grid.noImage")}
                </span>
              )}
              {item.state === "planned" && (
                <span className="instagram-planned">
                  {t("calendar.grid.planned")}
                </span>
              )}
              {item.mediaCount > 1 && (
                <Layers
                  size={14}
                  className="instagram-carousel"
                  aria-label={t("calendar.grid.carousel")}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// PDF of the client's calendar for a chosen period, every channel included.
export function CalendarExport({
  clientId,
  timeZone,
}: {
  clientId: string;
  timeZone: string;
}) {
  const { t, locale } = useT();
  const month = DateTime.now().setZone(timeZone).startOf("month");
  const [from, setFrom] = useState(month.toISODate()!);
  const [to, setTo] = useState(month.endOf("month").toISODate()!);
  const start = DateTime.fromISO(from);
  const end = DateTime.fromISO(to);
  const valid =
    start.isValid &&
    end.isValid &&
    end >= start &&
    end.diff(start, "days").days + 1 <= 93;
  const href = `/api/calendar/export?${new URLSearchParams({ clientId, from, to, locale })}`;
  return (
    <section className="panel">
      <div className="panel-title">
        <div>
          <h2>{t("calendar.export.title")}</h2>
          <p className="panel-note">{t("calendar.export.subtitle")}</p>
        </div>
      </div>
      <div className="calendar-filters">
        <label>
          {t("calendar.export.from")}
          <input
            type="date"
            value={from}
            onChange={(event) => setFrom(event.target.value)}
          />
        </label>
        <label>
          {t("calendar.export.to")}
          <input
            type="date"
            value={to}
            onChange={(event) => setTo(event.target.value)}
          />
        </label>
        {valid ? (
          <a className="button primary" href={href} download>
            {t("calendar.export.download")}
          </a>
        ) : (
          <span role="alert" className="panel-note">
            {t("calendar.export.invalid")}
          </span>
        )}
      </div>
    </section>
  );
}
