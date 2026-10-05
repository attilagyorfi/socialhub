import { z } from "zod";
import { AppError } from "../../../../../packages/core/security";
import { context } from "../../../../../packages/server/context";
import { expireDueApprovals } from "../../../../../packages/server/approvals";
import { getPost, listPosts } from "../../../../../packages/server/post-list";
import { postListQueryInput } from "../../../../../packages/server/validation";

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
      event: "posts_api_error",
      code: "INTERNAL_ERROR",
      errorName: error instanceof Error ? error.name : "Unknown",
    }),
  );
  return Response.json(
    {
      error: "The post list is temporarily unavailable.",
      code: "SERVICE_UNAVAILABLE",
    },
    { status: 503 },
  );
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const input = postListQueryInput.parse({
      clientId: url.searchParams.get("clientId"),
      id: url.searchParams.get("id") || undefined,
      query: url.searchParams.get("query") || undefined,
      status: url.searchParams.get("status") || undefined,
      platform: url.searchParams.get("platform") || undefined,
      authorId: url.searchParams.get("authorId") || undefined,
      approvalOnly: url.searchParams.get("approvalOnly") === "true",
      cursor: url.searchParams.get("cursor") || undefined,
      limit: Number(url.searchParams.get("limit") || 25),
    });
    const c = await context(request, input.clientId);
    await expireDueApprovals(c);
    if (input.id)
      return Response.json(
        { post: await getPost(c, input.id) },
        { headers: { "Cache-Control": "no-store" } },
      );
    return Response.json(await listPosts(c, input), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return failure(error);
  }
}
