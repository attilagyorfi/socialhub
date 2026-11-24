import { listIntegrationClients } from "../../../../../../packages/server/api-keys";
import { apiV1 } from "../handler";

export const runtime = "nodejs";

export async function GET(request: Request) {
  return apiV1(request, async (key) => ({
    data: await listIntegrationClients(key.organizationId),
  }));
}
