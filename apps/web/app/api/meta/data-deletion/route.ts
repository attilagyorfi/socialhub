import { AppError } from "../../../../../../packages/core/security";
import { handleMetaDataDeletion } from "../../../../../../packages/server/meta-compliance";

export const runtime = "nodejs";

// Meta's Data Deletion Request Callback; the response is shown to the person.
export async function POST(request: Request) {
  try {
    const form = await request.formData();
    return Response.json(
      await handleMetaDataDeletion(form.get("signed_request")),
    );
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof AppError
            ? error.message
            : "Data deletion request failed.",
        code: error instanceof AppError ? error.code : "META_CALLBACK_FAILED",
      },
      { status: error instanceof AppError ? error.status : 503 },
    );
  }
}
