"use client";
import { useState } from "react";
export default function Login() {
  const [mode, setMode] = useState<"sign-in" | "sign-up" | "magic-link">(
    "sign-in",
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <main className="login">
      <section className="login-story">
        <div className="wordmark">
          g2a<span> / social hub</span>
        </div>
        <div>
          <p className="eyebrow">BUILT AROUND YOUR CLIENTS</p>
          <h1>
            Good content.
            <br />A clear way forward.
          </h1>
          <p>
            Bring your brands, approvals and publishing schedule together in one
            workspace.
          </p>
        </div>
        <small>G2A Marketing · Agency workspace</small>
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
              if (!res.ok) throw new Error(data.message ?? "Sign-in failed");
              if (mode === "magic-link")
                setError("Check your email for a sign-in link.");
              else window.location.href = "/";
            } catch (e) {
              setError(e instanceof Error ? e.message : "Unable to sign in");
            } finally {
              setBusy(false);
            }
          }}
        >
          <p className="eyebrow">YOUR AGENCY, CONNECTED</p>
          <h2>{mode === "sign-up" ? "Create your account" : "Welcome back"}</h2>
          <p className="muted">Sign in to your Social Hub workspace.</p>
          {mode === "sign-up" && (
            <label>
              Your name
              <input name="name" autoComplete="name" required />
            </label>
          )}
          <label>
            Email address
            <input
              name="email"
              type="email"
              autoComplete="email"
              required
              placeholder="you@agency.com"
            />
          </label>
          {mode !== "magic-link" && (
            <label>
              Password
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
              ? "Please wait…"
              : mode === "magic-link"
                ? "Email me a sign-in link"
                : mode === "sign-up"
                  ? "Create account"
                  : "Sign in"}
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
                ? "Already have an account?"
                : "Create an account"}
            </button>
            <button
              type="button"
              className="text-button"
              onClick={() =>
                setMode(mode === "magic-link" ? "sign-in" : "magic-link")
              }
            >
              {mode === "magic-link" ? "Use password" : "Use a magic link"}
            </button>
          </div>
          <small>
            By continuing, you acknowledge the{" "}
            <a href="/legal/privacy">Privacy Policy</a> and{" "}
            <a href="/legal/terms">Terms</a>.
          </small>
        </form>
      </section>
    </main>
  );
}
