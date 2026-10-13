"use client";
import { useEffect, useState } from "react";
import { LOCALES, useT, type Locale, type MessageKey } from "../../i18n";

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

export default function Login() {
  const { t, locale, setLocale } = useT();
  const [mode, setMode] = useState<
    "sign-in" | "sign-up" | "magic-link" | "forgot"
  >("sign-in");
  // The reset page links back here with ?forgot=1 to request a new link.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).has("forgot"))
      setMode("forgot");
  }, []);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
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
              const endpoint =
                mode === "magic-link" ? "sign-in/magic-link" : `${mode}/email`;
              const res = await fetch(`/api/auth/${endpoint}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  email: f.get("email"),
                  password: f.get("password"),
                  name: f.get("name"),
                  callbackURL: "/",
                }),
              });
              const data = await res.json();
              if (!res.ok)
                throw new Error(
                  authErrorMessage(locale, t, data, "auth.login.signInFailed"),
                );
              if (mode === "magic-link") setNotice(t("auth.login.checkEmail"));
              // Sign-up without a session means the address must be confirmed.
              else if (mode === "sign-up" && !data?.token)
                setNotice(t("auth.login.verifySent"));
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
            {mode === "sign-up"
              ? t("auth.login.createTitle")
              : mode === "forgot"
                ? t("auth.forgot.title")
                : t("auth.login.welcomeBack")}
          </h2>
          <p className="muted">
            {mode === "forgot"
              ? t("auth.forgot.subtitle")
              : t("auth.login.subtitle")}
          </p>
          {mode === "sign-up" && (
            <label>
              {t("auth.field.name")}
              <input name="name" autoComplete="name" required />
            </label>
          )}
          <label>
            {t("auth.field.email")}
            <input
              name="email"
              type="email"
              autoComplete="email"
              required
              placeholder={t("auth.login.emailPlaceholder")}
            />
          </label>
          {mode !== "magic-link" && mode !== "forgot" && (
            <label>
              {t("auth.field.password")}
              <input
                name="password"
                type="password"
                minLength={mode === "sign-up" ? 12 : undefined}
                autoComplete={
                  mode === "sign-up" ? "new-password" : "current-password"
                }
                required
              />
            </label>
          )}
          {mode === "sign-in" && (
            <button
              type="button"
              className="text-button forgot-link"
              onClick={() => {
                setMode("forgot");
                setError("");
                setNotice("");
              }}
            >
              {t("auth.forgot.link")}
            </button>
          )}
          {error && (
            <p role="alert" className="alert">
              {error}
            </p>
          )}
          {notice && (
            <p role="status" className="success-notice">
              {notice}
            </p>
          )}
          <button className="primary" disabled={busy}>
            {busy
              ? t("auth.pleaseWait")
              : mode === "forgot"
                ? t("auth.forgot.submit")
                : mode === "magic-link"
                  ? t("auth.login.sendMagicLink")
                  : mode === "sign-up"
                    ? t("auth.login.createAccount")
                    : t("auth.login.signIn")}
          </button>
          {mode === "forgot" ? (
            <div className="login-options">
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  setMode("sign-in");
                  setNotice("");
                }}
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
                  setMode(mode === "sign-up" ? "sign-in" : "sign-up")
                }
              >
                {mode === "sign-up"
                  ? t("auth.haveAccount")
                  : t("auth.login.toSignUp")}
              </button>
              <button
                type="button"
                className="text-button"
                onClick={() =>
                  setMode(mode === "magic-link" ? "sign-in" : "magic-link")
                }
              >
                {mode === "magic-link"
                  ? t("auth.login.usePassword")
                  : t("auth.login.useMagicLink")}
              </button>
            </div>
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
