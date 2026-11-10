import * as Sentry from "@sentry/nextjs";
import { z } from "zod";
import { AppError, sameOrigin } from "../../../../../packages/core/security";
import { context, user } from "../../../../../packages/server/context";
import { rateLimit } from "../../../../../packages/server/queue";
import { uuid } from "../../../../../packages/server/validation";
import {
  createWebhookEndpoint,
  listWebhookEndpoints,
  revokeWebhookEndpoint,
  rotateWebhookSecret,
  webhookEvents,
} from "../../../../../packages/server/webhooks";

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

// Organization webhook endpoints for the settings page. The client ID only
// resolves the caller's organization and role; endpoints belong to the
// organization. Signing secrets appear only in create and rotate responses.
export async function GET(request: Request) {
  try {
    const clientId = uuid.parse(
      new URL(request.url).searchParams.get("clientId"),
    );
    const c = await context(request, clientId);
    return Response.json(
      { endpoints: await listWebhookEndpoints(c) },
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
    const c = await context(request, uuid.parse(body.clientId));
    const action = z.enum(["create", "revoke", "rotate"]).parse(body.action);
    if (action === "create")
      return Response.json(
        await createWebhookEndpoint(c, {
          url: z.string().trim().min(1).max(2048).parse(body.url),
          events: z
            .array(z.enum(webhookEvents))
            .min(1)
            .max(4)
            .parse(body.events),
        }),
        { headers },
      );
    const id = uuid.parse(body.id);
    return Response.json(
      action === "revoke"
        ? await revokeWebhookEndpoint(c, id)
        : await rotateWebhookSecret(c, id),
      { headers },
    );
  } catch (e) {
    return failure(e);
  }
}
