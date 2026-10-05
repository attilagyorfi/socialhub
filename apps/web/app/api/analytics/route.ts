import { z } from "zod";
import { AppError } from "../../../../../packages/core/security";
import { getAnalytics } from "../../../../../packages/server/analytics";
import { context } from "../../../../../packages/server/context";
import { analyticsQueryInput } from "../../../../../packages/server/validation";

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
      event: "analytics_api_error",
      code: "INTERNAL_ERROR",
      errorName: error instanceof Error ? error.name : "Unknown",
    }),
  );
  return Response.json(
    {
      error: "Analytics is temporarily unavailable.",
      code: "SERVICE_UNAVAILABLE",
    },
    { status: 503 },
  );
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const input = analyticsQueryInput.parse({
      clientId: url.searchParams.get("clientId"),
      from: url.searchParams.get("from"),
      to: url.searchParams.get("to"),
      platform: url.searchParams.get("platform") || undefined,
    });
    const c = await context(request, input.clientId);
    return Response.json(await getAnalytics(c, input), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return failure(error);
  }
}
