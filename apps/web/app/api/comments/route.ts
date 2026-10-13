import { z } from "zod";
import { AppError, sameOrigin } from "../../../../../packages/core/security";
import {
  listComments,
  replyToComment,
  setCommentHidden,
  setCommentStatus,
  syncClientComments,
} from "../../../../../packages/server/comments";
import { context } from "../../../../../packages/server/context";

export const runtime = "nodejs";

const uuid = z.string().uuid();

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
      event: "comments_api_error",
      code: "INTERNAL_ERROR",
      errorName: error instanceof Error ? error.name : "Unknown",
    }),
  );
  return Response.json(
    {
      error: "Comments are temporarily unavailable.",
      code: "SERVICE_UNAVAILABLE",
    },
    { status: 503 },
  );
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const c = await context(
      request,
      uuid.parse(url.searchParams.get("clientId")),
    );
    return Response.json(
      await listComments(c, {
        status: z
          .enum(["OPEN", "DONE", "ALL"])
          .catch("OPEN")
          .parse(url.searchParams.get("status") ?? "OPEN"),
        platform: z
          .enum(["facebook", "instagram"])
          .optional()
          .parse(url.searchParams.get("platform") || undefined),
        before: z
          .string()
          .datetime()
          .optional()
          .parse(url.searchParams.get("before") || undefined),
      }),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const body = await request.json();
    const action = z
      .enum(["reply", "hide", "status", "sync"])
      .parse(body.action);
    // Answering or hiding speaks for the client in public.
    const c = await context(
      request,
      uuid.parse(body.clientId),
      action === "reply" || action === "hide" ? "publish" : "create",
    );
    switch (action) {
      case "reply":
        return Response.json(
          await replyToComment(
            c,
            uuid.parse(body.id),
            z.string().trim().min(1).max(2000).parse(body.message),
          ),
        );
      case "hide":
        return Response.json(
          await setCommentHidden(
            c,
            uuid.parse(body.id),
            z.boolean().parse(body.hidden),
          ),
        );
      case "status":
        return Response.json(
          await setCommentStatus(
            c,
            uuid.parse(body.id),
            z.enum(["OPEN", "DONE"]).parse(body.status),
          ),
        );
      case "sync":
        return Response.json(await syncClientComments(c));
    }
  } catch (error) {
    return failure(error);
  }
}
