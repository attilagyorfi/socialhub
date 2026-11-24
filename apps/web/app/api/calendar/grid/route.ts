import * as Sentry from "@sentry/nextjs";
import { AppError } from "../../../../../../packages/core/security";
import { context } from "../../../../../../packages/server/context";
import { instagramGrid } from "../../../../../../packages/server/instagram-grid";
import { uuid } from "../../../../../../packages/server/validation";

export const runtime = "nodejs";

// Instagram profile preview next to the calendar, from stored data only.
export async function GET(request: Request) {
  try {
    const clientId = uuid.safeParse(
      new URL(request.url).searchParams.get("clientId"),
    );
    if (!clientId.success)
      throw new AppError(400, "VALIDATION", "Choose a client.");
    const c = await context(request, clientId.data);
    return Response.json(await instagramGrid(c), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (error instanceof AppError)
      return Response.json(
        { error: error.message, code: error.code },
        { status: error.status },
      );
    Sentry.captureException(error);
    return Response.json(
      {
        error: "The Instagram preview is temporarily unavailable.",
        code: "SERVICE_UNAVAILABLE",
      },
      { status: 503 },
    );
  }
}
