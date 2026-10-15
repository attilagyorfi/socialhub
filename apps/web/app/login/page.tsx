"use client";
import { useEffect, useState } from "react";
import {
  apiError,
  LOCALES,
  useT,
  type Locale,
  type MessageKey,
} from "../../i18n";

// English keeps Better Auth's own message; other locales map its error code.
function authErrorMessage(
  locale: Locale,
  t: (key: MessageKey) => string,
  body: { message?: string; code?: string } | undefined,
  fallback: MessageKey,
) {
  if (locale === "en") return body?.message ?? t(fallback);
  const key = `auth.code.${body?.code}` as MessageKey;
  const translated = body?.code ? t(key) : key;
  return translated === key ? t(fallback) : translated;
}

type Mode = "sign-in" | "request" | "magic-link" | "forgot";

export default function Login() {
  const { t, locale, setLocale } = useT();
  const [mode, setMode] = useState<Mode>("sign-in");
  const [error, setError] = useState("");
  // A notice means the form was sent: only the message stays on screen.
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  // The reset page links back here with ?forgot=1 to request a new link; a
  // refused magic-link sign-up returns with ?error=CODE.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.has("forgot")) setMode("forgot");
    const code = params.get("error");
    if (!code) return;
    window.history.replaceState({}, "", window.location.pathname);
    setError(
      authErrorMessage(
        locale,
        t,
        { code, message: params.get("error_description") ?? undefined },
        "auth.login.signInFailed",
      ),
    );
  }, []);
  const switchTo = (next: Mode) => {
    setMode(next);
    setError("");
    setNotice("");
  };
  return (
    <main className="login">
      <section className="login-story">
        <div className="wordmark">
          <img
            className="wordmark-mark"
            src="/brand/socialhub-mark-on-dark.png"
            alt=""
          />
          g2a<span>{t("auth.login.wordmark")}</span>
        </div>
        <div>
          <p className="eyebrow">{t("auth.login.eyebrow")}</p>
          <h1>
            {t("auth.login.headline1")}
            <br />
            {t("auth.login.headline2")}
          </h1>
          <p>{t("auth.login.lead")}</p>
        </div>
        <small>{t("auth.login.footer")}</small>
      </section>
      <section className="login-form">
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            setNotice("");
            const f = new FormData(e.currentTarget);
            if (mode === "forgot") {
              try {
                await fetch("/api/auth/request-password-reset", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    email: f.get("email"),
                    redirectTo: "/reset-password",
                  }),
                });
              } finally {
                // Same answer whether or not the account exists.
                setNotice(t("auth.forgot.sent"));
                setBusy(false);
              }
              return;
            }
            try {
              if (mode === "request") {
                const res = await fetch("/api/access-requests", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    name: f.get("name"),
                    email: f.get("email"),
                    company: f.get("company") || undefined,
                    message: f.get("message") || undefined,
                    locale,
                  }),
                });
                if (!res.ok)
                  throw new Error(
                    apiError(await res.json().catch(() => null), locale),
                  );
                setNotice(t("auth.login.requestSent"));
                return;
              }
              const endpoint =
                mode === "magic-link" ? "sign-in/magic-link" : "sign-in/email";
              const res = await fetch(`/api/auth/${endpoint}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  email: f.get("email"),
                  password: f.get("password"),
                  callbackURL: "/",
                  ...(mode === "magic-link" && { errorCallbackURL: "/login" }),
                }),
              });
              const data = await res.json();
              if (!res.ok)
                throw new Error(
                  authErrorMessage(locale, t, data, "auth.login.signInFailed"),
                );
              if (mode === "magic-link") setNotice(t("auth.login.checkEmail"));
              else window.location.href = "/";
            } catch (e) {
              setError(
                e instanceof Error ? e.message : t("auth.login.unableToSignIn"),
              );
            } finally {
              setBusy(false);
            }
          }}
        >
          <p className="eyebrow">{t("auth.login.formEyebrow")}</p>
          <h2>
            {mode === "request"
              ? t("auth.login.requestTitle")
              : mode === "forgot"
                ? t("auth.forgot.title")
                : t("auth.login.welcomeBack")}
          </h2>
          {notice ? (
            <>
              <p role="status" className="success-notice">
                {notice}
              </p>
              <div className="login-options">
                <button
                  type="button"
                  className="text-button"
                  onClick={() => switchTo("sign-in")}
                >
                  {t("auth.forgot.back")}
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="muted">
                {mode === "forgot"
                  ? t("auth.forgot.subtitle")
                  : mode === "request"
                    ? t("auth.login.requestSubtitle")
                    : t("auth.login.subtitle")}
              </p>
              {mode === "request" && (
                <label>
                  {t("auth.field.name")}
                  <input
                    name="name"
                    autoComplete="name"
                    required
                    maxLength={120}
                  />
                </label>
              )}
              <label>
                {t("auth.field.email")}
                <input
                  name="email"
                  type="email"
                  autoComplete="email"
                  required
                  maxLength={320}
                  placeholder={t("auth.login.emailPlaceholder")}
                />
              </label>
              {mode === "request" && (
                <>
                  <label>
                    {t("auth.field.company")}
                    <input
                      name="company"
                      autoComplete="organization"
                      maxLength={160}
                    />
                  </label>
                  <label>
                    {t("auth.field.message")}
                    <textarea name="message" rows={3} maxLength={1000} />
                  </label>
                </>
              )}
              {mode === "sign-in" && (
                <label>
                  {t("auth.field.password")}
                  <input
                    name="password"
                    type="password"
                    autoComplete="current-password"
                    required
                  />
                </label>
              )}
              {mode === "sign-in" && (
                <button
                  type="button"
                  className="text-button forgot-link"
                  onClick={() => switchTo("forgot")}
                >
                  {t("auth.forgot.link")}
                </button>
              )}
              {error && (
                <p role="alert" className="alert">
                  {error}
                </p>
              )}
              <button className="primary" disabled={busy}>
                {busy
                  ? t("auth.pleaseWait")
                  : mode === "forgot"
                    ? t("auth.forgot.submit")
                    : mode === "magic-link"
                      ? t("auth.login.sendMagicLink")
                      : mode === "request"
                        ? t("auth.login.requestSubmit")
                        : t("auth.login.signIn")}
              </button>
              {mode === "forgot" ? (
                <div className="login-options">
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => switchTo("sign-in")}
                  >
                    {t("auth.forgot.back")}
                  </button>
                </div>
              ) : (
                <div className="login-options">
                  <button
                    type="button"
                    className="text-button"
                    onClick={() =>
                      switchTo(mode === "request" ? "sign-in" : "request")
                    }
                  >
                    {mode === "request"
                      ? t("auth.haveAccount")
                      : t("auth.login.toRequest")}
                  </button>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() =>
                      switchTo(mode === "magic-link" ? "sign-in" : "magic-link")
                    }
                  >
                    {mode === "magic-link"
                      ? t("auth.login.usePassword")
                      : t("auth.login.useMagicLink")}
                  </button>
                </div>
              )}
            </>
          )}
          <small>
            {t("auth.login.consent.before")}{" "}
            <a href="/legal/privacy">{t("auth.login.consent.privacy")}</a>{" "}
            {t("auth.login.consent.and")}{" "}
            <a href="/legal/terms">{t("auth.login.consent.terms")}</a>
            {t("auth.login.consent.after")}
          </small>
          <div
            className="login-options language-switch"
            role="group"
            aria-label={t("auth.login.language")}
          >
            {LOCALES.map((option, index) => (
              <span key={option}>
                {index > 0 && (
                  <span aria-hidden="true" className="language-sep">
                    ·
                  </span>
                )}
                <button
                  type="button"
                  className="text-button"
                  aria-pressed={locale === option}
                  disabled={locale === option}
                  onClick={() => setLocale(option)}
                >
                  {t(`common.language.${option}`)}
                </button>
              </span>
            ))}
          </div>
        </form>
      </section>
    </main>
  );
}
