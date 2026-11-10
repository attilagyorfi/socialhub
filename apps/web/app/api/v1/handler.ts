import * as Sentry from "@sentry/nextjs";
import { AppError } from "../../../../../packages/core/security";
import {
  authenticateApiKey,
  type ApiKeyContext,
} from "../../../../../packages/server/api-keys";
import { rateLimitWithRetry } from "../../../../../packages/server/queue";

const headers = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

export const maxRequestBytes = 1_000_000;

// Requests per API key, and failed authentications per client IP, in one
// window. Counters live in Redis, so the limits hold across web instances.
export const apiKeyRequestLimit = 120;
export const authFailureLimit = 20;
export const rateLimitWindowSeconds = 60;

class RateLimited extends AppError {
  constructor(readonly retryAfter: number) {
    super(429, "RATE_LIMITED", "Too many requests. Retry later.");
  }
}

// The same headers better-auth reads (see packages/server/auth.ts): the
// platform proxy sets them from the connecting client. Requests without
// either share one bucket.
export function clientIp(request: Request) {
  return (
    request.headers.get("x-real-ip")?.trim() ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

async function authenticate(request: Request) {
  const failures = `api-v1-auth-fail:${clientIp(request)}`;
  // An IP over its failure budget is refused before any key is looked up.
  const ip = await rateLimitWithRetry(
    failures,
    authFailureLimit,
    rateLimitWindowSeconds,
    false,
  );
  if (!ip.allowed) throw new RateLimited(ip.retryAfter);
  try {
    return await authenticateApiKey(request);
  } catch (error) {
    if (error instanceof AppError && error.status === 401)
      await rateLimitWithRetry(
        failures,
        authFailureLimit,
        rateLimitWindowSeconds,
      );
    throw error;
  }
}

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
// else (including reading the body), applies the rate limits, scopes the
// request to the key's organization and returns uncacheable JSON. A Redis
// failure ends in 503 like any other unexpected error: limits never fail open.
export async function apiV1(
  request: Request,
  handler: (key: ApiKeyContext) => Promise<unknown>,
) {
  try {
    const key = await authenticate(request);
    const limit = await rateLimitWithRetry(
      `api-v1-key:${key.keyId}`,
      apiKeyRequestLimit,
      rateLimitWindowSeconds,
    );
    if (!limit.allowed) throw new RateLimited(limit.retryAfter);
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
        {
          status: error.status,
          headers:
            error instanceof RateLimited
              ? { ...headers, "Retry-After": String(error.retryAfter) }
              : headers,
        },
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
