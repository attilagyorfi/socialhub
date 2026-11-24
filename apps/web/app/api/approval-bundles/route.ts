import * as Sentry from "@sentry/nextjs";
import { z } from "zod";
import { AppError, sameOrigin } from "../../../../../packages/core/security";
import { context, user } from "../../../../../packages/server/context";
import { rateLimit } from "../../../../../packages/server/queue";
import { uuid } from "../../../../../packages/server/validation";
import {
  createApprovalBundle,
  listApprovalBundles,
  maxBundleExpiryDays,
  revokeApprovalBundle,
} from "../../../../../packages/server/approval-bundles";

export const runtime = "nodejs";

const headers = { "Cache-Control": "no-store" };

function failure(e: unknown) {
  if (e instanceof z.ZodError)
    return Response.json(
      { error: e.issues.map((i) => i.message).join(" "), code: "VALIDATION" },
      { status: 422, headers },
    );
  if (e instanceof AppError)
    return Response.json(
      { error: e.message, code: e.code },
      { status: e.status, headers },
    );
  Sentry.captureException(e);
  return Response.json(
    { error: "The service is unavailable.", code: "SERVICE_UNAVAILABLE" },
    { status: 503, headers },
  );
}

// Monthly approval links of one client. The link itself appears only in the
// create response; the server stores just its hash.
export async function GET(request: Request) {
  try {
    const clientId = uuid.parse(
      new URL(request.url).searchParams.get("clientId"),
    );
    const c = await context(request, clientId, "approve");
    return Response.json(
      { bundles: await listApprovalBundles(c) },
      { headers },
    );
  } catch (e) {
    return failure(e);
  }
}

export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const actor = await user(request);
    if (!(await rateLimit(actor.id)))
      throw new AppError(
        429,
        "RATE_LIMIT",
        "Too many requests. Try again shortly.",
      );
    const body = await request.json();
    const c = await context(request, uuid.parse(body.clientId), "approve");
    const action = z.enum(["create", "revoke"]).parse(body.action);
    if (action === "create")
      return Response.json(
        await createApprovalBundle(c, {
          periodStart: z.iso.datetime({ offset: true }).parse(body.periodStart),
          periodEnd: z.iso.datetime({ offset: true }).parse(body.periodEnd),
          expiresInDays: z
            .number()
            .int()
            .min(1)
            .max(maxBundleExpiryDays)
            .optional()
            .parse(body.expiresInDays),
        }),
        { headers },
      );
    return Response.json(await revokeApprovalBundle(c, uuid.parse(body.id)), {
      headers,
    });
  } catch (e) {
    return failure(e);
  }
}
