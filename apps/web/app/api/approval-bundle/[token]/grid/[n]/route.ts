import { GetObjectCommand } from "@aws-sdk/client-s3";
import { z } from "zod";
import { bundleGridMedia } from "../../../../../../../../packages/server/approval-bundles";
import {
  mediaBucket,
  storageClient,
} from "../../../../../../../../packages/server/media";
import { rateLimit } from "../../../../../../../../packages/server/queue";
import {
  AppError,
  hashToken,
} from "../../../../../../../../packages/core/security";
export const runtime = "nodejs";
const params = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  n: z.coerce.number().int().min(1).max(200),
});
const headers = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
};
// Cover images of the Instagram preview on the public bundle page. The number
// is the entry's place in the grid; the server resolves it again with the
// same rules, so only the bundle client's own stored media can come out.
// Nothing is fetched from outside the app's storage.
export async function GET(
  _request: Request,
  context: { params: Promise<{ token: string; n: string }> },
) {
  try {
    const parsed = params.safeParse(await context.params);
    if (!parsed.success)
      throw new AppError(404, "NOT_FOUND", "Media not found.");
    const { token, n } = parsed.data;
    if (!(await rateLimit(`approval-bundle-grid:${hashToken(token)}`, 300)))
      throw new AppError(429, "RATE_LIMIT", "Please try again shortly.");
    const asset = await bundleGridMedia(token, n);
    const object = await storageClient().send(
      new GetObjectCommand({ Bucket: mediaBucket(), Key: asset.object_key }),
    );
    if (!object.Body) throw new AppError(404, "NOT_FOUND", "Media not found.");
    return new Response(object.Body.transformToWebStream(), {
      headers: {
        ...headers,
        "Content-Type": asset.mime_type,
        ...(object.ContentLength
          ? { "Content-Length": String(object.ContentLength) }
          : {}),
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  } catch (e) {
    return Response.json(
      {
        error:
          e instanceof AppError && e.status === 429
            ? e.message
            : "Media not found.",
      },
      {
        status: e instanceof AppError && e.status !== 404 ? e.status : 404,
        headers,
      },
    );
  }
}
