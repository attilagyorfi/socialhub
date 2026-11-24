import * as Sentry from "@sentry/nextjs";
import { AppError } from "../../../../../../packages/core/security";
import { context } from "../../../../../../packages/server/context";
import {
  exportCalendarPdf,
  exportPeriod,
} from "../../../../../../packages/server/calendar-pdf";
import { userPreferences } from "../../../../../../packages/server/preferences";
import { rateLimit } from "../../../../../../packages/server/queue";
import { uuid } from "../../../../../../packages/server/validation";
import {
  DEFAULT_LOCALE,
  isLocale,
  LOCALE_COOKIE,
  translate,
  type MessageKey,
} from "../../../../i18n/core";

export const runtime = "nodejs";

function cookieLocale(request: Request) {
  const match = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((part) => part.trim().split("="))
    .find(([name]) => name === LOCALE_COOKIE);
  return isLocale(match?.[1]) ? match[1] : undefined;
}

// Calendar of one client and period as a PDF. Same access rule as the
// calendar: signed-in members who can read the client; other organizations'
// clients look unknown (404).
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const clientId = uuid.safeParse(url.searchParams.get("clientId"));
    if (!clientId.success)
      throw new AppError(400, "VALIDATION", "Choose a client.");
    const c = await context(request, clientId.data);
    const preferences = await userPreferences(c.userId);
    const requested = url.searchParams.get("locale");
    const locale = isLocale(requested)
      ? requested
      : (preferences.locale ?? cookieLocale(request) ?? DEFAULT_LOCALE);
    const period = exportPeriod(
      url.searchParams.get("from"),
      url.searchParams.get("to"),
      preferences.timezone,
    );
    if (!(await rateLimit(`calendar-pdf:${c.userId}`, 20)))
      throw new AppError(
        429,
        "RATE_LIMIT",
        "Too many requests. Try again shortly.",
      );
    const { clientName, bytes } = await exportCalendarPdf(c, {
      ...period,
      timeZone: preferences.timezone,
      locale,
      t: (key, vars) => translate(locale, key as MessageKey, vars),
    });
    const stem = `${clientName}-${url.searchParams.get("from")}-${url.searchParams.get("to")}`;
    const ascii = stem
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^\w.-]+/g, "-")
      .replace(/-+/g, "-");
    return new Response(bytes as BodyInit, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${ascii}.pdf"; filename*=UTF-8''${encodeURIComponent(stem)}.pdf`,
        "Content-Length": String(bytes.length),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof AppError)
      return Response.json(
        { error: error.message, code: error.code },
        { status: error.status },
      );
    Sentry.captureException(error);
    console.error(
      JSON.stringify({
        event: "calendar_pdf_error",
        errorName: error instanceof Error ? error.name : "Unknown",
      }),
    );
    return Response.json(
      {
        error: "The calendar export is temporarily unavailable.",
        code: "SERVICE_UNAVAILABLE",
      },
      { status: 503 },
    );
  }
}
