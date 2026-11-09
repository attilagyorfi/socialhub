import { listApiPosts } from "../../../../../../packages/server/api-v1-posts";
import { apiV1 } from "../handler";

export const runtime = "nodejs";

export async function GET(request: Request) {
  return apiV1(request, (key) =>
    listApiPosts(key, new URL(request.url).searchParams),
  );
}
