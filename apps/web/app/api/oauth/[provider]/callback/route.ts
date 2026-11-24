import { context } from "../../../../../../../packages/server/context";
import { pool } from "../../../../../../../packages/db";
import {
  AppError,
  hashToken,
} from "../../../../../../../packages/core/security";
import {
  completeMetaOAuth,
  metaProviderError,
} from "../../../../../../../packages/server/meta";
import { handleLinkedInCallback } from "../../../../../../../packages/server/linkedin";

export const runtime = "nodejs";

function appRedirect(
  result: "connected" | "error",
  code?: string,
  provider: "meta" | "linkedin" = "meta",
) {
  const url = new URL(process.env.APP_URL ?? "http://localhost:3010");
  url.searchParams.set(provider, result);
  if (code) url.searchParams.set("code", code);
  return Response.redirect(url, 303);
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ provider: string }> },
) {
  const name = (await params).provider;
  if (!["meta", "linkedin", "tiktok", "google"].includes(name))
    return Response.json({ error: "Unknown provider" }, { status: 404 });
  if (name === "linkedin") return linkedInCallback(request);
  if (name !== "meta")
    return Response.json(
      {
        error: "This provider is not configured.",
        code: "PROVIDER_NOT_CONFIGURED",
      },
      { status: 503 },
    );
  const url = new URL(request.url);
  const state = url.searchParams.get("state");
  if (!state) return appRedirect("error", "OAUTH_STATE_MISSING");
  const found = (
    await pool.query(
      "SELECT * FROM oauth_states WHERE state_hash=$1 AND provider='meta' AND expires_at>now()",
      [hashToken(state)],
    )
  ).rows[0];
  if (!found) return appRedirect("error", "OAUTH_STATE_INVALID");
  try {
    const c = await context(request, found.client_id, "manage");
    if (c.userId !== found.user_id)
      throw new AppError(
        403,
        "OAUTH_SESSION_MISMATCH",
        "OAuth session mismatch.",
      );
    const consumed = await pool.query(
      "DELETE FROM oauth_states WHERE id=$1 AND expires_at>now() RETURNING id",
      [found.id],
    );
    if (!consumed.rowCount)
      throw new AppError(403, "OAUTH_STATE_INVALID", "OAuth state expired.");
    if (url.searchParams.has("error"))
      throw new AppError(
        400,
        "OAUTH_DENIED",
        "Meta authorization was cancelled.",
      );
    const code = url.searchParams.get("code");
    if (!code)
      throw new AppError(400, "OAUTH_CODE_MISSING", "OAuth code missing.");
    await completeMetaOAuth(c, code);
    return appRedirect("connected");
  } catch (error) {
    const code = error instanceof AppError ? error.code : "OAUTH_FAILED";
    console.error(
      JSON.stringify({
        event: "meta_oauth_failed",
        code,
        errorName: error instanceof Error ? error.name : "Unknown",
        provider: metaProviderError(error),
      }),
    );
    return appRedirect("error", code);
  }
}

async function linkedInCallback(request: Request) {
  const url = new URL(request.url);
  try {
    await handleLinkedInCallback(
      {
        state: url.searchParams.get("state"),
        code: url.searchParams.get("code"),
        error: url.searchParams.get("error"),
      },
      (clientId) => context(request, clientId, "manage"),
    );
    return appRedirect("connected", undefined, "linkedin");
  } catch (error) {
    const code = error instanceof AppError ? error.code : "OAUTH_FAILED";
    // Error codes only: provider messages and tokens are never logged.
    console.error(
      JSON.stringify({
        event: "linkedin_oauth_failed",
        code,
        errorName: error instanceof Error ? error.name : "Unknown",
      }),
    );
    return appRedirect("error", code, "linkedin");
  }
}
