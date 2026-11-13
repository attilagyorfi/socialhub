"use client";
import { use, useCallback, useEffect, useState } from "react";
import {
  apiError,
  intlLocale,
  isLocale,
  LOCALE_COOKIE,
  translate,
  useT,
  type Locale,
  type MessageKey,
  type Vars,
} from "../../../../i18n";

// A visitor's explicit language choice (cookie) wins; otherwise the page
// follows the client's language.
function cookieLocale() {
  const match = document.cookie.match(
    new RegExp(`(?:^|; )${LOCALE_COOKIE}=([^;]*)`),
  );
  return match && isLocale(match[1]) ? match[1] : undefined;
}

type Item = {
  item: number;
  state: "PENDING" | "APPROVED" | "CHANGES_REQUESTED" | "UNAVAILABLE";
  scheduled_at: string | null;
  caption: string;
  link: string | null;
  versions: {
    platform: string | null;
    name: string | null;
    caption: string;
    media: { file: string; name: string; mime_type: string }[];
  }[];
  comments: { author: string; body: string; created_at: string }[];
};

// Monthly approval: every post of the period on one page. The client approves
// all waiting posts at once or decides post by post; decisions are saved one
// by one, so the page shows the current state when the client returns.
export default function BundleApproval({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = use(params);
  const [data, setData] = useState<any>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [changesFor, setChangesFor] = useState<number | null>(null);
  const [comment, setComment] = useState("");
  const { locale: appLocale } = useT();
  const [chosen, setChosen] = useState<Locale>();
  useEffect(() => setChosen(cookieLocale()), []);
  const locale: Locale =
    chosen ?? (isLocale(data?.locale) ? data.locale : appLocale);
  const t = (key: MessageKey, vars?: Vars) => translate(locale, key, vars);
  const timeZone = data?.timezone ?? "Europe/Budapest";
  const date = (value: string, withTime = true) =>
    new Date(value).toLocaleString(intlLocale(locale), {
      timeZone,
      dateStyle: "long",
      ...(withTime ? { timeStyle: "short" } : {}),
    });
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  const load = useCallback(async () => {
    const r = await fetch(`/api/approval-bundle/${token}`);
    const d = await r.json();
    if (!r.ok) throw new Error(apiError(d));
    setData(d);
  }, [token]);
  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, [load]);
  async function decide(body: Record<string, unknown>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const res = await fetch(`/api/approval-bundle/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(apiError(result, locale));
      if (body.action === "approve_all")
        setNotice(
          [
            t("approve.bundle.approveAllDone", { approved: result.approved }),
            result.skipped
              ? t("approve.bundle.approveAllSkipped", {
                  skipped: result.skipped,
                })
              : "",
          ]
            .filter(Boolean)
            .join(" "),
        );
      setChangesFor(null);
      setComment("");
    } catch (e) {
      setError(e instanceof Error ? e.message : t("approve.saveFailed"));
    } finally {
      // Reload in every case: a failed decision usually means the post was
      // decided elsewhere in the meantime.
      await load().catch(() => {});
      setBusy(false);
    }
  }
  const items: Item[] = data?.items ?? [];
  const pending = data?.summary?.pending ?? 0;
  return (
    <main className="approval-page">
      <div className="wordmark dark">
        <img
          className="wordmark-mark"
          src="/brand/socialhub-mark-on-light.png"
          alt=""
        />
        g2a<span>{t("approve.wordmark")}</span>
      </div>
      <section className="panel">
        <div className="panel-title">
          <div>
            <p className="eyebrow">{t("approve.bundle.title")}</p>
            <h1>{data?.client_name ?? t("approve.title")}</h1>
          </div>
        </div>
        <div className="dialog-body">
          {error && (
            <p className="alert" role="alert">
              {error}
            </p>
          )}
          {notice && (
            <div className="notice" role="status">
              {notice}
            </div>
          )}
          {data && (
            <>
              <p>
                {t("approve.bundle.intro", {
                  period: `${date(data.period_start, false)} – ${date(
                    new Date(
                      new Date(data.period_end).getTime() - 1,
                    ).toISOString(),
                    false,
                  )}`,
                })}
              </p>
              <p className="muted">
                {t("approve.bundle.summary", {
                  approved: data.summary.approved,
                  total: data.summary.total,
                  changes: data.summary.changesRequested,
                  pending,
                })}
              </p>
              {pending > 0 ? (
                <div className="button-row">
                  <button
                    className="primary"
                    disabled={busy}
                    onClick={() => {
                      if (
                        window.confirm(
                          t("approve.bundle.approveAllConfirm", {
                            count: pending,
                          }),
                        )
                      )
                        void decide({ action: "approve_all" });
                    }}
                  >
                    {t("approve.bundle.approveAll")}
                  </button>
                </div>
              ) : (
                <div className="notice" role="status">
                  {t("approve.bundle.allDecided")}
                </div>
              )}
              {items.map((item) => (
                <article className="target-detail" key={item.item}>
                  <strong>
                    {t("approve.bundle.item", { n: item.item })} ·{" "}
                    {item.scheduled_at
                      ? date(item.scheduled_at)
                      : t("approve.bundle.noDate")}{" "}
                    · {t(`approve.bundle.state.${item.state}` as MessageKey)}
                  </strong>
                  {item.versions.map((version, i) => (
                    <div key={i}>
                      <p className="muted">
                        {version.platform
                          ? t(`common.network.${version.platform}` as MessageKey)
                          : ""}
                        {version.name ? ` · ${version.name}` : ""}
                      </p>
                      <p className="caption-full">{version.caption}</p>
                      <div className="approval-media">
                        {version.media.map((m) => {
                          const src = `/api/approval-bundle/${token}/media/${item.item}/${m.file}`;
                          return (
                            <div key={m.file}>
                              {m.mime_type.startsWith("video/") ? (
                                <video src={src} controls preload="metadata" />
                              ) : (
                                <img src={src} alt={m.name} loading="lazy" />
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                  {item.comments.map((c, i) => (
                    <blockquote key={i}>
                      <strong>{c.author}</strong>
                      <p>{c.body}</p>
                    </blockquote>
                  ))}
                  {item.state === "UNAVAILABLE" && (
                    <p className="muted">{t("approve.bundle.unavailable")}</p>
                  )}
                  {item.state === "PENDING" &&
                    (changesFor === item.item ? (
                      <>
                        <label>
                          {t("approve.bundle.changesLabel")}
                          <textarea
                            rows={3}
                            maxLength={5000}
                            placeholder={t("approve.bundle.changesPlaceholder")}
                            value={comment}
                            onChange={(e) => setComment(e.target.value)}
                          />
                        </label>
                        <div className="button-row">
                          <button
                            className="primary"
                            disabled={busy || !comment.trim()}
                            onClick={() =>
                              void decide({
                                action: "changes",
                                item: item.item,
                                comment,
                              })
                            }
                          >
                            {t("approve.bundle.sendChanges")}
                          </button>
                          <button
                            disabled={busy}
                            onClick={() => {
                              setChangesFor(null);
                              setComment("");
                            }}
                          >
                            {t("approve.bundle.cancel")}
                          </button>
                        </div>
                      </>
                    ) : (
                      <div className="button-row">
                        <button
                          className="primary"
                          disabled={busy}
                          onClick={() =>
                            void decide({ action: "approve", item: item.item })
                          }
                        >
                          {t("approve.bundle.approveItem")}
                        </button>
                        <button
                          disabled={busy}
                          onClick={() => {
                            setChangesFor(item.item);
                            setComment("");
                          }}
                        >
                          {t("approve.bundle.requestChanges")}
                        </button>
                      </div>
                    ))}
                </article>
              ))}
              <small>
                {t("approve.expires", { date: date(data.expires_at, false) })}
              </small>
            </>
          )}
        </div>
      </section>
    </main>
  );
}
