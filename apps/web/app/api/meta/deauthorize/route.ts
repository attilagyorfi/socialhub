import { AppError } from "../../../../../../packages/core/security";
import { handleMetaDeauthorize } from "../../../../../../packages/server/meta-compliance";

export const runtime = "nodejs";

// Meta calls this when someone removes the app from their account settings.
export async function POST(request: Request) {
  try {
    const form = await request.formData();
    await handleMetaDeauthorize(form.get("signed_request"));
    return Response.json({ received: true });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof AppError ? error.message : "Deauthorize failed.",
        code: error instanceof AppError ? error.code : "META_CALLBACK_FAILED",
      },
      { status: error instanceof AppError ? error.status : 503 },
    );
  }
}
