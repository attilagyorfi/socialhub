import sharp from "sharp";
import { AppError } from "../core/security";

export async function inspectImage(data: Buffer) {
  try {
    const image = sharp(data, {
      limitInputPixels: 25_000_000,
      failOn: "warning",
    });
    const metadata = await image.metadata();
    if (
      !["png", "jpeg", "webp"].includes(metadata.format ?? "") ||
      !metadata.width ||
      !metadata.height
    )
      throw new Error("Unsupported image");
    // Decode all pixels, so a plausible file header is not sufficient to pass validation.
    await image.stats();
    return { width: metadata.width, height: metadata.height };
  } catch {
    throw new AppError(
      422,
      "INVALID_IMAGE",
      "The image is damaged, unsupported or exceeds 25 megapixels.",
    );
  }
}

export async function boundedForm(request: Request) {
  const limit = 21 * 1024 * 1024;
  if (Number(request.headers.get("content-length")) > limit)
    throw new AppError(413, "FILE_SIZE", "The upload exceeds 20 MB.");
  if (!request.body) throw new AppError(400, "FILE_REQUIRED", "Choose a file.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new AppError(413, "FILE_SIZE", "The upload exceeds 20 MB.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return new Response(Buffer.concat(chunks), {
    headers: { "Content-Type": request.headers.get("content-type") ?? "" },
  }).formData();
}
