"use client";
import { useEffect, useState } from "react";
import { useT, type MessageKey } from "../../i18n";

// Landing page of the emailed reset link: Better Auth appends ?token=…
// (or ?error=INVALID_TOKEN when the link expired or was already used).
export default function ResetPassword() {
  const { t } = useT();
  const [token, setToken] = useState<string | null>();
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setToken(params.get("error") ? null : params.get("token"));
  }, []);
  const invalid = token === null;
  return (
    <main className="approval-page invitation-page">
      <div className="wordmark dark">
        <img
          className="wordmark-mark"
          src="/brand/socialhub-mark-on-light.png"
          alt=""
        />
        g2a<span>{t("auth.reset.wordmark")}</span>
      </div>
      <section className="panel invitation-card">
        <p className="eyebrow">{t("auth.reset.eyebrow")}</p>
        <h1>{t("auth.reset.title")}</h1>
        {done ? (
          <>
            <p className="success-notice" role="status">
              {t("auth.reset.done")}
            </p>
            <a className="button primary" href="/login">
              {t("auth.reset.toLogin")}
            </a>
          </>
        ) : invalid ? (
          <>
            <p className="alert" role="alert">
              {t("auth.reset.invalid")}
            </p>
            <a className="button primary" href="/login?forgot=1">
              {t("auth.reset.requestNew")}
            </a>
          </>
        ) : (
          <form
            className="invite-auth"
            onSubmit={async (event) => {
              event.preventDefault();
              const values = new FormData(event.currentTarget);
              const password = String(values.get("password") ?? "");
              if (password !== values.get("confirm")) {
                setError(t("auth.reset.mismatch"));
                return;
              }
              setBusy(true);
              setError("");
              try {
                const response = await fetch("/api/auth/reset-password", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ newPassword: password, token }),
                });
                const result = await response.json().catch(() => ({}));
                if (!response.ok) {
                  if (result?.code === "INVALID_TOKEN") setToken(null);
                  else
                    setError(
                      t(
                        result?.code === "PASSWORD_TOO_SHORT"
                          ? "auth.code.PASSWORD_TOO_SHORT"
                          : ("auth.reset.failed" as MessageKey),
                      ),
                    );
                  return;
                }
                setDone(true);
              } finally {
                setBusy(false);
              }
            }}
          >
            <p className="muted">{t("auth.reset.intro")}</p>
            <label>
              {t("auth.reset.newPassword")}
              <input
                name="password"
                type="password"
                autoComplete="new-password"
                minLength={12}
                required
              />
            </label>
            <label>
              {t("auth.reset.confirm")}
              <input
                name="confirm"
                type="password"
                autoComplete="new-password"
                minLength={12}
                required
              />
            </label>
            {error && (
              <p className="alert" role="alert">
                {error}
              </p>
            )}
            <button className="primary" disabled={busy || !token}>
              {busy ? t("auth.pleaseWait") : t("auth.reset.submit")}
            </button>
          </form>
        )}
      </section>
    </main>
  );
}
