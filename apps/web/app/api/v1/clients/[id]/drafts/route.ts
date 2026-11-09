import {
  createApiDrafts,
  parseIdempotencyKey,
} from "../../../../../../../../packages/server/api-v1-posts";
import { ApiV1Reply, apiV1, readJsonBody } from "../../../handler";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  route: { params: Promise<{ id: string }> },
) {
  return apiV1(request, async (key) => {
    const idempotencyKey = parseIdempotencyKey(
      request.headers.get("idempotency-key"),
    );
    const body = await readJsonBody(request);
    const { id } = await route.params;
    const reply = await createApiDrafts(key, id, idempotencyKey, body);
    return new ApiV1Reply(
      reply.status,
      reply.body,
      reply.replayed ? { "Idempotent-Replayed": "true" } : {},
    );
  });
}
