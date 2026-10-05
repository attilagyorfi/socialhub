import { z } from "zod";
import { AppError } from "../../../../../packages/core/security";
import { context } from "../../../../../packages/server/context";
import { listGenerations } from "../../../../../packages/server/ai";
import { uuid } from "../../../../../packages/server/validation";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const c = await context(
      request,
      uuid.parse(url.searchParams.get("clientId")),
    );
    const limit = z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .default(20)
      .parse(url.searchParams.get("limit") ?? undefined);
    return Response.json(
      { generations: await listGenerations(c, limit) },
      {
        headers: { "Cache-Control": "no-store" },
      },
    );
  } catch (error) {
    if (error instanceof z.ZodError)
      return Response.json(
        { error: "Invalid generation query.", code: "VALIDATION" },
        { status: 422 },
      );
    if (error instanceof AppError)
      return Response.json(
        { error: error.message, code: error.code },
        { status: error.status },
      );
    return Response.json(
      { error: "Unable to load AI history.", code: "SERVICE_UNAVAILABLE" },
      { status: 503 },
    );
  }
}
