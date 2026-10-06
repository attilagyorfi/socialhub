"use client";
import { use, useEffect, useState } from "react";
import {
  apiError,
  intlLocale,
  useT,
  type Locale,
  type MessageKey,
} from "../../../i18n";

type Invitation = {
  email: string;
  role: string;
  organization_name: string;
  expires_at: string;
  clients: { id: string; name: string }[];
};

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

export default function InvitationPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = use(params);
  const { t, locale } = useT();
  const [data, setData] = useState<Invitation>();
  const [sessionEmail, setSessionEmail] = useState<string>();
  const [mode, setMode] = useState<"sign-up" | "sign-in">("sign-up");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    Promise.all([
      fetch(`/api/invitation/${token}`).then(async (response) => {
        const result = await response.json();
        if (!response.ok) throw new Error(apiError(result));
        return result;
      }),
      fetch("/api/auth/get-session").then((response) => response.json()),
    ])
      .then(([invitation, session]) => {
        setData(invitation);
        setSessionEmail(session?.user?.email);
      })
      .catch((reason) => setError(reason.message));
  }, [token]);

  async function accept() {
    const response = await fetch(`/api/invitation/${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const result = await response.json();
    if (!response.ok) throw new Error(apiError(result));
    window.location.href = "/";
  }

  return (
    <main className="approval-page invitation-page">
      <div className="wordmark dark">
        g2a<span>{t("auth.invite.wordmark")}</span>
      </div>
      <section className="panel invitation-card">
        <p className="eyebrow">{t("auth.invite.eyebrow")}</p>
        <h1>
          {data?.organization_name ?? t("auth.invite.fallbackTitle")}
        </h1>
        {error && (
          <p className="alert" role="alert">
            {error}
          </p>
        )}
        {data && (
          <>
            <p>
              {t("auth.invite.joinAs")}{" "}
              <strong>
                {t(`auth.invite.role.${data.role}` as MessageKey)}
              </strong>
              {data.clients.length
                ? t("auth.invite.accessClients", {
                    clients: data.clients
                      .map((client) => client.name)
                      .join(", "),
                  })
                : t("auth.invite.accessAll")}
            </p>
            {sessionEmail ? (
              sessionEmail.toLowerCase() === data.email ? (
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() => {
                    setBusy(true);
                    setError("");
                    accept().catch((reason) => {
                      setError(reason.message);
                      setBusy(false);
                    });
                  }}
                >
                  {busy
                    ? t("auth.invite.joining")
                    : t("auth.invite.accept")}
                </button>
              ) : (
                <div className="notice">
                  {t("auth.invite.wrongAccountBefore")}{" "}
                  <strong>{data.email}</strong>{" "}
                  {t("auth.invite.wrongAccountAfter")}
                  <button
                    onClick={async () => {
                      await fetch("/api/auth/sign-out", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: "{}",
                      });
                      setSessionEmail(undefined);
                    }}
                  >
                    {t("auth.invite.signOut")}
                  </button>
                </div>
              )
            ) : (
              <form
                className="invite-auth"
                onSubmit={async (event) => {
                  event.preventDefault();
                  setBusy(true);
                  setError("");
                  const values = new FormData(event.currentTarget);
                  try {
                    const response = await fetch(`/api/auth/${mode}/email`, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        email: data.email,
                        password: values.get("password"),
                        name: values.get("name"),
                      }),
                    });
                    const result = await response.json();
                    if (!response.ok)
                      throw new Error(
                        authErrorMessage(
                          locale,
                          t,
                          result,
                          "auth.invite.authFailed",
                        ),
                      );
                    await accept();
                  } catch (reason) {
                    setError(
                      reason instanceof Error
                        ? reason.message
                        : t("auth.invite.unableToJoin"),
                    );
                    setBusy(false);
                  }
                }}
              >
                <label>
                  {t("auth.field.email")}
                  <input value={data.email} readOnly />
                </label>
                {mode === "sign-up" && (
                  <label>
                    {t("auth.field.name")}
                    <input name="name" autoComplete="name" required />
                  </label>
                )}
                <label>
                  {t("auth.field.password")}
                  <input
                    name="password"
                    type="password"
                    autoComplete={
                      mode === "sign-up" ? "new-password" : "current-password"
                    }
                    minLength={mode === "sign-up" ? 12 : undefined}
                    required
                  />
                </label>
                <button className="primary" disabled={busy}>
                  {busy
                    ? t("auth.pleaseWait")
                    : mode === "sign-up"
                      ? t("auth.invite.createAndJoin")
                      : t("auth.invite.signInAndJoin")}
                </button>
                <button
                  type="button"
                  className="text-button"
                  onClick={() =>
                    setMode(mode === "sign-up" ? "sign-in" : "sign-up")
                  }
                >
                  {mode === "sign-up"
                    ? t("auth.haveAccount")
                    : t("auth.invite.toSignUp")}
                </button>
              </form>
            )}
            <small>
              {t("auth.invite.expires", {
                date: new Date(data.expires_at).toLocaleDateString(
                  intlLocale(locale),
                ),
              })}
            </small>
          </>
        )}
      </section>
    </main>
  );
}
