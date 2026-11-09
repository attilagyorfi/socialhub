import * as Sentry from "@sentry/nextjs";
import { AppError } from "../../../../../packages/core/security";
import {
  authenticateApiKey,
  type ApiKeyContext,
} from "../../../../../packages/server/api-keys";

const headers = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

// Wraps an /api/v1 handler: authenticates the Bearer API key, scopes the
// request to the key's organization and returns uncacheable JSON.
export async function apiV1(
  request: Request,
  handler: (key: ApiKeyContext) => Promise<unknown>,
) {
  try {
    const key = await authenticateApiKey(request);
    return Response.json(await handler(key), { headers });
  } catch (error) {
    if (error instanceof AppError)
      return Response.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status, headers },
      );
    Sentry.captureException(error);
    console.error(
      JSON.stringify({
        event: "api_v1_error",
        errorName: error instanceof Error ? error.name : "Unknown",
      }),
    );
    return Response.json(
      {
        error: {
          code: "SERVICE_UNAVAILABLE",
          message: "The service is temporarily unavailable.",
        },
      },
      { status: 503, headers },
    );
  }
}
