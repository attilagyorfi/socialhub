import * as Sentry from "@sentry/nextjs";
import { scrubEvent, sentryOptions } from "../../packages/core/telemetry";

// Browser error reporting; disabled unless NEXT_PUBLIC_SENTRY_DSN is set at
// build time. The DSN is a public identifier, not a secret.
const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
if (dsn)
  Sentry.init({
    ...sentryOptions(dsn),
    beforeSend: (event) => scrubEvent(event),
    beforeBreadcrumb: (crumb) =>
      scrubEvent({ breadcrumbs: [crumb] }).breadcrumbs![0],
  });

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
