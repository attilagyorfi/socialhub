"use client";
import { useState } from "react";
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
  const [mode, setMode] = useState<"sign-in" | "sign-up" | "magic-link">(
    "sign-in",
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <main className="login">
      <section className="login-story">
        <div className="wordmark">
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
            const f = new FormData(e.currentTarget);
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
              if (mode === "magic-link")
                setError(t("auth.login.checkEmail"));
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
              : t("auth.login.welcomeBack")}
          </h2>
          <p className="muted">{t("auth.login.subtitle")}</p>
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
          {mode !== "magic-link" && (
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
          {error && (
            <p role="status" className="notice">
              {error}
            </p>
          )}
          <button className="primary" disabled={busy}>
            {busy
              ? t("auth.pleaseWait")
              : mode === "magic-link"
                ? t("auth.login.sendMagicLink")
                : mode === "sign-up"
                  ? t("auth.login.createAccount")
                  : t("auth.login.signIn")}
          </button>
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
                {index > 0 && " · "}
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
