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

export const maxRequestBytes = 1_000_000;

// Returned by a handler that needs a status other than 200 or extra headers;
// any other value is sent as a 200 JSON body.
export class ApiV1Reply {
  constructor(
    readonly status: number,
    readonly body: unknown,
    readonly headers: Record<string, string> = {},
  ) {}
}

const tooLarge = () =>
  new AppError(
    413,
    "PAYLOAD_TOO_LARGE",
    `The request body must be at most ${maxRequestBytes} bytes.`,
  );

// Reads a JSON body without buffering more than maxRequestBytes, whatever
// Content-Length claims.
export async function readJsonBody(request: Request) {
  if (Number(request.headers.get("content-length") ?? 0) > maxRequestBytes)
    throw tooLarge();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (request.body) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxRequestBytes) {
        await reader.cancel();
        throw tooLarge();
      }
      chunks.push(value);
    }
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new AppError(400, "INVALID_JSON", "The request body must be JSON.");
  }
}

// Wraps an /api/v1 handler: authenticates the Bearer API key before anything
// else (including reading the body), scopes the request to the key's
// organization and returns uncacheable JSON.
export async function apiV1(
  request: Request,
  handler: (key: ApiKeyContext) => Promise<unknown>,
) {
  try {
    const key = await authenticateApiKey(request);
    const result = await handler(key);
    if (result instanceof ApiV1Reply)
      return Response.json(result.body, {
        status: result.status,
        headers: { ...result.headers, ...headers },
      });
    return Response.json(result, { headers });
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
