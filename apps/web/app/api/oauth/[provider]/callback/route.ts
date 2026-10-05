import { context } from "../../../../../../../packages/server/context";
import { pool } from "../../../../../../../packages/db";
import {
  AppError,
  hashToken,
} from "../../../../../../../packages/core/security";
import { completeMetaOAuth } from "../../../../../../../packages/server/meta";

export const runtime = "nodejs";

function appRedirect(result: "connected" | "error", code?: string) {
  const url = new URL(process.env.APP_URL ?? "http://localhost:3010");
  url.searchParams.set("meta", result);
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
    if (!(error instanceof AppError))
      console.error(
        JSON.stringify({
          event: "meta_oauth_failed",
          code,
          errorName: error instanceof Error ? error.name : "Unknown",
        }),
      );
    return appRedirect("error", code);
  }
}
