"use client";
import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

// Last-resort boundary for render errors in the root layout.
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);
  return (
    <html lang="hu">
      <body>
        <main className="legal">
          <h1>Hiba történt · Something went wrong</h1>
          <p>
            Az oldal nem tudott betöltődni. Próbáld újra. · The page could not
            be loaded. Please try again.
          </p>
          <button onClick={reset}>Újra · Try again</button>
        </main>
      </body>
    </html>
  );
}
