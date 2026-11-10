import { putSyncedBrandProfile } from "../../../../../../../../packages/server/brand-profile";
import { apiV1, readJsonBody } from "../../../handler";

export const runtime = "nodejs";

export async function PUT(
  request: Request,
  route: { params: Promise<{ id: string }> },
) {
  return apiV1(request, async (key) => {
    const { id } = await route.params;
    return putSyncedBrandProfile(key, id, await readJsonBody(request));
  });
}
