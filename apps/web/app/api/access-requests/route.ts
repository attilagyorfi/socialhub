import * as Sentry from "@sentry/nextjs";
import { z } from "zod";
import { AppError, sameOrigin } from "../../../../../packages/core/security";
import { submitAccessRequest } from "../../../../../packages/server/access-requests";
import { rateLimit } from "../../../../../packages/server/queue";
import { localeInput } from "../../../../../packages/server/validation";

export const runtime = "nodejs";

const input = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.email().max(320),
  company: z.string().trim().max(160).optional(),
  message: z.string().trim().max(1000).optional(),
  locale: localeInput,
});

// The proxy's first forwarded address identifies the visitor.
const clientIp = (request: Request) =>
  request.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
  request.headers.get("x-real-ip") ||
  "unknown";

export async function POST(request: Request) {
  try {
    sameOrigin(request);
    if (!(await rateLimit(`access-request:${clientIp(request)}`, 10, 3600)))
      throw new AppError(
        429,
        "RATE_LIMIT",
        "Too many requests. Try again later.",
      );
    await submitAccessRequest(input.parse(await request.json()));
    return Response.json({ ok: true }, { status: 202 });
  } catch (error) {
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
    Sentry.captureException(error);
    console.error(
      JSON.stringify({
        event: "access_request_failed",
        errorName: error instanceof Error ? error.name : "Unknown",
      }),
    );
    return Response.json(
      { error: "The request could not be sent.", code: "SERVICE_UNAVAILABLE" },
      { status: 503 },
    );
  }
}
