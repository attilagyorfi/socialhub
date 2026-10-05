import { z } from "zod";
import { AppError, sameOrigin } from "../../../../../packages/core/security";
import { context } from "../../../../../packages/server/context";
import { rateLimit } from "../../../../../packages/server/queue";
import {
  listCalendarPosts,
  reschedulePost,
} from "../../../../../packages/server/calendar";
import {
  calendarQueryInput,
  uuid,
} from "../../../../../packages/server/validation";

export const runtime = "nodejs";

function failure(error: unknown) {
  if (error instanceof z.ZodError)
    return Response.json(
      {
        error: error.issues.map((issue) => issue.message).join(" "),
        code: "VALIDATION",
      },
      { status: 422 },
    );
  if (error instanceof AppError)
    return Response.json(
      { error: error.message, code: error.code },
      { status: error.status },
    );
  console.error(
    JSON.stringify({
      event: "calendar_api_error",
      code: "INTERNAL_ERROR",
      errorName: error instanceof Error ? error.name : "Unknown",
    }),
  );
  return Response.json(
    {
      error: "The calendar is temporarily unavailable.",
      code: "SERVICE_UNAVAILABLE",
    },
    { status: 503 },
  );
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const input = calendarQueryInput.parse({
      clientId: url.searchParams.get("clientId"),
      from: url.searchParams.get("from"),
      to: url.searchParams.get("to"),
      platform: url.searchParams.get("platform") || undefined,
      status: url.searchParams.get("status") || undefined,
      authorId: url.searchParams.get("authorId") || undefined,
    });
    const c = await context(request, input.clientId);
    return Response.json(await listCalendarPosts(c, input), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return failure(error);
  }
}

export async function PATCH(request: Request) {
  try {
    sameOrigin(request);
    const body = await request.json();
    const clientId = uuid.parse(body.clientId);
    const c = await context(request, clientId, "publish");
    if (!(await rateLimit(c.userId)))
      throw new AppError(
        429,
        "RATE_LIMIT",
        "Too many requests. Try again shortly.",
      );
    return Response.json(
      await reschedulePost(
        c,
        uuid.parse(body.id),
        z.iso.datetime({ offset: true }).parse(body.scheduledAt),
        z.number().int().positive().parse(body.expectedRevision),
      ),
    );
  } catch (error) {
    return failure(error);
  }
}
