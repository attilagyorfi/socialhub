import { getClientMetrics } from "../../../../../../../../packages/server/api-v1-metrics";
import { apiV1 } from "../../../handler";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  route: { params: Promise<{ id: string }> },
) {
  return apiV1(request, async (key) => {
    const { id } = await route.params;
    return getClientMetrics(key, id, new URL(request.url).searchParams);
  });
}
