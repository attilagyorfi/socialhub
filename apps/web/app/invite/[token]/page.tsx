"use client";
import { use, useEffect, useState } from "react";

type Invitation = {
  email: string;
  role: string;
  organization_name: string;
  expires_at: string;
  clients: { id: string; name: string }[];
};

export default function InvitationPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = use(params);
  const [data, setData] = useState<Invitation>();
  const [sessionEmail, setSessionEmail] = useState<string>();
  const [mode, setMode] = useState<"sign-up" | "sign-in">("sign-up");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    Promise.all([
      fetch(`/api/invitation/${token}`).then(async (response) => {
        const result = await response.json();
        if (!response.ok) throw new Error(result.error);
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
    if (!response.ok) throw new Error(result.error);
    window.location.href = "/";
  }

  return (
    <main className="approval-page invitation-page">
      <div className="wordmark dark">
        g2a<span> / workspace invitation</span>
      </div>
      <section className="panel invitation-card">
        <p className="eyebrow">YOU’RE INVITED</p>
        <h1>{data?.organization_name ?? "Workspace invitation"}</h1>
        {error && (
          <p className="alert" role="alert">
            {error}
          </p>
        )}
        {data && (
          <>
            <p>
              Join as{" "}
              <strong>{data.role.toLowerCase().replaceAll("_", " ")}</strong>
              {data.clients.length
                ? ` with access to ${data.clients.map((client) => client.name).join(", ")}`
                : " with access to all clients"}
              .
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
                  {busy ? "Joining…" : "Accept invitation"}
                </button>
              ) : (
                <div className="notice">
                  Sign out and use <strong>{data.email}</strong> to accept this
                  invitation.
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
                    Sign out
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
                        result.message ?? "Authentication failed.",
                      );
                    await accept();
                  } catch (reason) {
                    setError(
                      reason instanceof Error
                        ? reason.message
                        : "Unable to join.",
                    );
                    setBusy(false);
                  }
                }}
              >
                <label>
                  Email address
                  <input value={data.email} readOnly />
                </label>
                {mode === "sign-up" && (
                  <label>
                    Your name
                    <input name="name" autoComplete="name" required />
                  </label>
                )}
                <label>
                  Password
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
                    ? "Please wait…"
                    : mode === "sign-up"
                      ? "Create account and join"
                      : "Sign in and join"}
                </button>
                <button
                  type="button"
                  className="text-button"
                  onClick={() =>
                    setMode(mode === "sign-up" ? "sign-in" : "sign-up")
                  }
                >
                  {mode === "sign-up"
                    ? "Already have an account?"
                    : "Create a new account"}
                </button>
              </form>
            )}
            <small>
              This invitation expires{" "}
              {new Date(data.expires_at).toLocaleDateString()}.
            </small>
          </>
        )}
      </section>
    </main>
  );
}
