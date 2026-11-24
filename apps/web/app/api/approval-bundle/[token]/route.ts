import { z } from "zod";
import {
  bundleView,
  decideBundle,
} from "../../../../../../packages/server/approval-bundles";
import {
  sameOrigin,
  AppError,
  hashToken,
} from "../../../../../../packages/core/security";
import { rateLimit } from "../../../../../../packages/server/queue";
export const runtime = "nodejs";
const valid = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const headers = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
};
const decision = z.discriminatedUnion("action", [
  z.object({ action: z.literal("approve_all") }),
  z.object({
    action: z.literal("approve"),
    item: z.number().int().min(1).max(200),
    comment: z.string().max(5000).default(""),
  }),
  z.object({
    action: z.literal("changes"),
    item: z.number().int().min(1).max(200),
    comment: z.string().trim().min(1).max(5000),
  }),
]);
// A malformed link gets the same answer as an unknown, expired or revoked one.
function secretOf(value: string) {
  const parsed = valid.safeParse(value);
  if (!parsed.success)
    throw new AppError(
      404,
      "EXPIRED",
      "This approval link is invalid or expired.",
    );
  return parsed.data;
}
function failure(e: unknown) {
  return Response.json(
    {
      error:
        e instanceof AppError ? e.message : "Unable to process the approval.",
      ...(e instanceof AppError ? { code: e.code } : {}),
    },
    { status: e instanceof AppError ? e.status : 400, headers },
  );
}
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  try {
    return Response.json(
      await bundleView(secretOf((await params).token)),
      { headers },
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
    const secret = secretOf((await params).token);
    // Key by hash so live approval secrets never appear in Redis.
    if (!(await rateLimit(`approval-bundle:${hashToken(secret)}`)))
      throw new AppError(429, "RATE_LIMIT", "Please try again shortly.");
    const body = decision.parse(await request.json());
    return Response.json(await decideBundle(secret, body), { headers });
  } catch (e) {
    return failure(e);
  }
}
