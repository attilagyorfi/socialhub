import * as Sentry from "@sentry/nextjs";
import { scrubEvent, sentryOptions } from "../../packages/core/telemetry";

// Server-side error reporting; disabled unless SENTRY_DSN is set.
export async function register() {
  if (!process.env.SENTRY_DSN) return;
  Sentry.init({
    ...sentryOptions(process.env.SENTRY_DSN),
    beforeSend: (event) => scrubEvent(event),
    beforeBreadcrumb: (crumb) =>
      scrubEvent({ breadcrumbs: [crumb] }).breadcrumbs![0],
  });
}

export const onRequestError = Sentry.captureRequestError;
