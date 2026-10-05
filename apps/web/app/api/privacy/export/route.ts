import { AppError } from "../../../../../../packages/core/security";
import { user } from "../../../../../../packages/server/context";
import { exportUserData } from "../../../../../../packages/server/privacy";
import { rateLimit } from "../../../../../../packages/server/queue";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const actor = await user(request);
    if (!(await rateLimit(`privacy-export:${actor.id}`, 5, 60 * 60)))
      throw new AppError(
        429,
        "RATE_LIMIT",
        "Too many export requests. Try again later.",
      );
    const data = await exportUserData(actor.id);
    return new Response(JSON.stringify(data, null, 2), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="g2a-social-hub-personal-data-${new Date().toISOString().slice(0, 10)}.json"`,
        "Cache-Control": "no-store, max-age=0",
        Pragma: "no-cache",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    const status = error instanceof AppError ? error.status : 500;
    return Response.json(
      {
        error:
          error instanceof AppError
            ? error.message
            : "Unable to prepare the personal data export.",
        code: error instanceof AppError ? error.code : "EXPORT_FAILED",
      },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  }
}
