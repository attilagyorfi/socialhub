import { z } from "zod";
import { AppError } from "../../../../../../packages/core/security";
import { context } from "../../../../../../packages/server/context";
import { generation } from "../../../../../../packages/server/ai";
import { uuid } from "../../../../../../packages/server/validation";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  route: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await route.params;
    const url = new URL(request.url);
    const c = await context(
      request,
      uuid.parse(url.searchParams.get("clientId")),
    );
    return Response.json(await generation(c, uuid.parse(id)), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (error instanceof z.ZodError)
      return Response.json(
        { error: "Invalid generation request.", code: "VALIDATION" },
        { status: 422 },
      );
    if (error instanceof AppError)
      return Response.json(
        { error: error.message, code: error.code },
        { status: error.status },
      );
    return Response.json(
      { error: "Unable to load AI generation.", code: "SERVICE_UNAVAILABLE" },
      { status: 503 },
    );
  }
}
