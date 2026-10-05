import { z } from "zod";
import { AppError, sameOrigin } from "../../../../../../packages/core/security";
import { user } from "../../../../../../packages/server/context";
import {
  acceptInvitation,
  invitationView,
} from "../../../../../../packages/server/team";
import { rateLimit } from "../../../../../../packages/server/queue";

const valid = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
function failure(error: unknown) {
  return Response.json(
    {
      error:
        error instanceof AppError
          ? error.message
          : "Unable to process the invitation.",
    },
    { status: error instanceof AppError ? error.status : 400 },
  );
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  try {
    return Response.json(
      await invitationView(valid.parse((await params).token)),
      {
        headers: {
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
        },
      },
    );
  } catch (error) {
    return failure(error);
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  try {
    sameOrigin(request);
    const secret = valid.parse((await params).token);
    const actor = await user(request);
    if (!(await rateLimit(`invitation:${actor.id}`)))
      throw new AppError(429, "RATE_LIMIT", "Please try again shortly.");
    return Response.json(
      await acceptInvitation(secret, { id: actor.id, email: actor.email }),
    );
  } catch (error) {
    return failure(error);
  }
}
