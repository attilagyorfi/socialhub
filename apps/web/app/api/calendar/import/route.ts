import * as Sentry from "@sentry/nextjs";
import { z } from "zod";
import { maxImportBytes } from "../../../../../../packages/core/calendar-import";
import { AppError, sameOrigin } from "../../../../../../packages/core/security";
import {
  ImportInvalidError,
  importCalendar,
  previewCalendarImport,
} from "../../../../../../packages/server/calendar-import";
import { context } from "../../../../../../packages/server/context";
import { rateLimit } from "../../../../../../packages/server/queue";
import { uuid } from "../../../../../../packages/server/validation";

export const runtime = "nodejs";

const headers = { "Cache-Control": "no-store" };
// Room for the multipart boundaries and the other form fields.
const maxRequestBytes = maxImportBytes + 64 * 1024;
const tooLarge = () =>
  new AppError(
    413,
    "IMPORT_TOO_LARGE",
    "A fájl túl nagy: legfeljebb 1 MB lehet.",
  );

function failure(e: unknown) {
  if (e instanceof ImportInvalidError)
    return Response.json(
      { error: e.message, code: e.code, preview: e.preview },
      { status: e.status, headers },
    );
  // Only the form's own fields (clientId, mode) are parsed with zod here; the
  // UI shows the code's translation, never zod's English text.
  if (e instanceof z.ZodError)
    return Response.json(
      {
        error: "The import request is invalid. Reload the page.",
        code: "IMPORT_REQUEST",
      },
      { status: 422, headers },
    );
  if (e instanceof AppError)
    return Response.json(
      { error: e.message, code: e.code },
      { status: e.status, headers },
    );
  Sentry.captureException(e);
  return Response.json(
    { error: "The service is unavailable.", code: "SERVICE_UNAVAILABLE" },
    { status: 503, headers },
  );
}

// Calendar import from a JSON or CSV file. mode=preview validates and writes
// nothing; mode=import re-validates the same raw file and creates drafts.
export async function POST(request: Request) {
  try {
    sameOrigin(request);
    if (Number(request.headers.get("content-length")) > maxRequestBytes)
      throw tooLarge();
    const form = await request.formData();
    const clientId = uuid.parse(form.get("clientId"));
    const mode = z.enum(["preview", "import"]).parse(form.get("mode"));
    const c = await context(request, clientId, "create");
    if (!(await rateLimit(c.userId)))
      throw new AppError(
        429,
        "RATE_LIMIT",
        "Too many requests. Try again shortly.",
      );
    const file = form.get("file");
    if (!(file instanceof File))
      throw new AppError(422, "FILE_REQUIRED", "Choose a file.");
    if (file.size > maxImportBytes) throw tooLarge();
    const input = {
      name: file.name,
      bytes: new Uint8Array(await file.arrayBuffer()),
    };
    if (mode === "preview")
      return Response.json(await previewCalendarImport(c, input), { headers });
    return Response.json(await importCalendar(c, input), {
      status: 201,
      headers,
    });
  } catch (e) {
    return failure(e);
  }
}
