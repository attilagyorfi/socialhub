import { z } from "zod";
import {
  approvalView,
  decideApproval,
} from "../../../../../../packages/server/approvals";
import {
  sameOrigin,
  AppError,
  hashToken,
} from "../../../../../../packages/core/security";
import { rateLimit } from "../../../../../../packages/server/queue";
const valid = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
function failure(e: unknown) {
  return Response.json(
    {
      error:
        e instanceof AppError ? e.message : "Unable to process the approval.",
    },
    { status: e instanceof AppError ? e.status : 400 },
  );
}
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  try {
    return Response.json(
      await approvalView(valid.parse((await params).token)),
      {
        headers: {
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
        },
      },
    );
  } catch (e) {
    return failure(e);
  }
}
export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  try {
    sameOrigin(request);
    const secret = valid.parse((await params).token);
    // Key by hash so live approval secrets never appear in Redis.
    if (!(await rateLimit(`approval:${hashToken(secret)}`)))
      throw new AppError(429, "RATE_LIMIT", "Please try again shortly.");
    const body = z
      .object({
        action: z.enum(["approve", "changes", "comment"]),
        comment: z.string().max(5000).default(""),
      })
      .parse(await request.json());
    return Response.json(
      await decideApproval(secret, body.action, body.comment),
    );
  } catch (e) {
    return failure(e);
  }
}
