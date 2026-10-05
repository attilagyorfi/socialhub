import {
  ingestMetaWebhook,
  metaConfig,
  verifyMetaWebhookSignature,
} from "../../../../../../packages/server/meta";
import { AppError } from "../../../../../../packages/core/security";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const config = metaConfig();
    const url = new URL(request.url);
    const mode = url.searchParams.get("hub.mode");
    const verifyToken = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");
    if (
      mode !== "subscribe" ||
      !challenge ||
      !config.webhookVerifyToken ||
      verifyToken !== config.webhookVerifyToken
    )
      throw new AppError(
        403,
        "META_WEBHOOK_VERIFICATION_FAILED",
        "Webhook verification failed.",
      );
    return new Response(challenge, {
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  } catch (error) {
    const status = error instanceof AppError ? error.status : 503;
    return Response.json(
      {
        error: "Webhook verification failed.",
        code:
          error instanceof AppError ? error.code : "META_WEBHOOK_UNAVAILABLE",
      },
      { status },
    );
  }
}

export async function POST(request: Request) {
  try {
    const config = metaConfig();
    const raw = new Uint8Array(await request.arrayBuffer());
    if (raw.byteLength > 1_000_000)
      throw new AppError(
        413,
        "META_WEBHOOK_TOO_LARGE",
        "Webhook payload is too large.",
      );
    if (
      !verifyMetaWebhookSignature(
        raw,
        request.headers.get("x-hub-signature-256"),
        config.appSecret,
      )
    )
      throw new AppError(
        401,
        "META_WEBHOOK_SIGNATURE_INVALID",
        "Invalid webhook signature.",
      );
    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      throw new AppError(
        422,
        "META_WEBHOOK_INVALID",
        "Invalid webhook payload.",
      );
    }
    await ingestMetaWebhook(payload);
    return Response.json({ received: true });
  } catch (error) {
    const status = error instanceof AppError ? error.status : 503;
    return Response.json(
      {
        error:
          error instanceof AppError
            ? error.message
            : "Webhook processing failed.",
        code:
          error instanceof AppError ? error.code : "META_WEBHOOK_UNAVAILABLE",
      },
      { status },
    );
  }
}
