import { GetObjectCommand } from "@aws-sdk/client-s3";
import { z } from "zod";
import { bundleMedia } from "../../../../../../../../../packages/server/approval-bundles";
import {
  mediaBucket,
  storageClient,
} from "../../../../../../../../../packages/server/media";
import { AppError } from "../../../../../../../../../packages/core/security";
export const runtime = "nodejs";
const params = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  item: z.coerce.number().int().min(1).max(200),
  file: z.string().regex(/^\d{1,2}-\d{1,2}$/),
});
// Attachments of an approval bundle, streamed through the app: signed storage
// URLs contain organization and client IDs, which the public page must not see.
export async function GET(
  _request: Request,
  context: {
    params: Promise<{ token: string; item: string; file: string }>;
  },
) {
  try {
    const parsed = params.safeParse(await context.params);
    if (!parsed.success)
      throw new AppError(404, "NOT_FOUND", "Media not found.");
    const { token, item, file } = parsed.data;
    const asset = await bundleMedia(token, item, file);
    const object = await storageClient().send(
      new GetObjectCommand({ Bucket: mediaBucket(), Key: asset.object_key }),
    );
    if (!object.Body) throw new AppError(404, "NOT_FOUND", "Media not found.");
    return new Response(object.Body.transformToWebStream(), {
      headers: {
        "Content-Type": asset.mime_type,
        ...(object.ContentLength
          ? { "Content-Length": String(object.ContentLength) }
          : {}),
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  } catch (e) {
    return Response.json(
      { error: "Media not found." },
      {
        status: e instanceof AppError && e.status !== 404 ? e.status : 404,
        headers: {
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
        },
      },
    );
  }
}
