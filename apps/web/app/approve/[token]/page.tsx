"use client";
import { use, useEffect, useState } from "react";
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
} from "../../../i18n";

// A visitor's explicit language choice (cookie) wins; otherwise the page
// follows the client's language.
function cookieLocale() {
  const match = document.cookie.match(
    new RegExp(`(?:^|; )${LOCALE_COOKIE}=([^;]*)`),
  );
  return match && isLocale(match[1]) ? match[1] : undefined;
}
export default function Approval({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = use(params);
  const [data, setData] = useState<any>();
  const [error, setError] = useState("");
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const { locale: appLocale } = useT();
  const [chosen, setChosen] = useState<Locale>();
  useEffect(() => setChosen(cookieLocale()), []);
  const locale: Locale =
    chosen ?? (isLocale(data?.locale) ? data.locale : appLocale);
  const t = (key: MessageKey, vars?: Vars) => translate(locale, key, vars);
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  useEffect(() => {
    fetch(`/api/approval/${token}`)
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(apiError(d));
        setData(d);
      })
      .catch((e) => setError(e.message));
  }, [token]);
  async function decide(action: string) {
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/approval/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, comment }),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(apiError(result, locale));
      setData({ ...data, status: result.status });
      setComment("");
      if (action === "comment") {
        const updated = await fetch(`/api/approval/${token}`);
        setData(await updated.json());
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : t("approve.saveFailed"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="approval-page">
      <div className="wordmark dark">
        g2a<span>{t("approve.wordmark")}</span>
      </div>
      <section className="panel">
        <div className="panel-title">
          <div>
            <p className="eyebrow">{t("approve.eyebrow")}</p>
            <h1>{data?.client_name ?? t("approve.title")}</h1>
          </div>
        </div>
        <div className="dialog-body">
          {error && (
            <p className="alert" role="alert">
              {error}
            </p>
          )}
          {data && (
            <>
              <p className="caption-full">{data.caption}</p>
              <p className="muted">
                {data.scheduled_at
                  ? new Date(data.scheduled_at).toLocaleString(
                      intlLocale(locale),
                      { timeZone: data.timezone ?? "Europe/Budapest" },
                    )
                  : t("approve.schedulingFollows")}
              </p>
              {data.versions?.map((version: any, i: number) => (
                <div className="target-detail" key={i}>
                  <strong>
                    {t(`common.network.${version.platform}` as MessageKey)} ·{" "}
                    {version.name}
                  </strong>
                  <p>{version.caption}</p>
                  <div className="approval-media">
                    {version.media.map((m: any) => (
                      <div key={m.id}>
                        {m.mime_type.startsWith("video/") ? (
                          <video src={m.url} controls />
                        ) : (
                          <img src={m.url} alt={m.name} />
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
              {data.comments?.map((c: any, i: number) => (
                <blockquote key={i}>
                  <strong>{c.author}</strong>
                  <p>{c.body}</p>
                </blockquote>
              ))}
              {data.status === "PENDING" ? (
                <>
                  <label>
                    {t("approve.feedback")}
                    <textarea
                      rows={4}
                      placeholder={t("approve.placeholder")}
                      value={comment}
                      onChange={(e) => setComment(e.target.value)}
                    />
                  </label>
                  <div className="button-row">
                    <button
                      className="primary"
                      disabled={busy}
                      onClick={() => void decide("approve")}
                    >
                      {t("approve.approve")}
                    </button>
                    <button
                      disabled={busy || !comment.trim()}
                      onClick={() => void decide("changes")}
                    >
                      {t("approve.requestChanges")}
                    </button>
                    <button
                      disabled={busy || !comment.trim()}
                      onClick={() => void decide("comment")}
                    >
                      {t("approve.comment")}
                    </button>
                  </div>
                  <small>
                    {t("approve.expires", {
                      date: new Date(data.expires_at).toLocaleDateString(
                        intlLocale(locale),
                        { timeZone: data.timezone ?? "Europe/Budapest" },
                      ),
                    })}
                  </small>
                </>
              ) : (
                <div className="notice" role="status">
                  {t("approve.thanks", {
                    status: (() => {
                      const key = `approve.status.${data.status}` as MessageKey;
                      const label = t(key);
                      return label === key
                        ? data.status.toLowerCase().replaceAll("_", " ")
                        : label;
                    })(),
                  })}
                </div>
              )}
            </>
          )}
        </div>
      </section>
    </main>
  );
}
