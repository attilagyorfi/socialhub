import * as Sentry from "@sentry/nextjs";
import { z } from "zod";
import { can } from "../../../../../packages/core/domain";
import { AppError, sameOrigin } from "../../../../../packages/core/security";
import {
  completeClientUpload,
  decideClientUpload,
  listClientUploads,
  listOwnUploads,
  prepareClientUpload,
  withdrawClientUpload,
} from "../../../../../packages/server/client-media";
import { context, user } from "../../../../../packages/server/context";
import { rateLimit } from "../../../../../packages/server/queue";
import {
  clientMediaDecisionInput,
  clientMediaPrepareInput,
  clientMediaStatus,
  uuid,
} from "../../../../../packages/server/validation";

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

// Every role can read its own clients, so "forbidden" here means a client the
// user has nothing to do with; it looks the same as an unknown one.
async function portalContext(request: Request, clientId: string) {
  try {
    return await context(request, clientId);
  } catch (e) {
    if (e instanceof AppError && e.status === 403)
      throw new AppError(404, "NOT_FOUND", "Client not found.");
    throw e;
  }
}

// The team gets the client's uploads by status, a reviewer their own ones.
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const c = await portalContext(
      request,
      uuid.parse(url.searchParams.get("clientId")),
    );
    const before = uuid
      .optional()
      .parse(url.searchParams.get("before") || undefined);
    return Response.json(
      can(c.role, "create")
        ? await listClientUploads(
            c,
            clientMediaStatus.parse(
              url.searchParams.get("status") ?? "PENDING",
            ),
            before,
          )
        : await listOwnUploads(c, before),
      { headers },
    );
  } catch (e) {
    return failure(e);
  }
}

// The service checks the role of each action: uploading is for CLIENT_REVIEWER
// alone, deciding needs the team's create right.
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
    const action = z
      .enum(["prepare", "complete", "withdraw", "decide"])
      .parse(body.action);
    const c = await portalContext(request, uuid.parse(body.clientId));
    const run = () => {
      switch (action) {
        case "prepare":
          return prepareClientUpload(c, clientMediaPrepareInput.parse(body));
        case "complete":
          return completeClientUpload(c, uuid.parse(body.id));
        case "withdraw":
          return withdrawClientUpload(c, uuid.parse(body.id));
        case "decide":
          return decideClientUpload(c, clientMediaDecisionInput.parse(body));
      }
    };
    return Response.json(await run(), { headers });
  } catch (e) {
    return failure(e);
  }
}
