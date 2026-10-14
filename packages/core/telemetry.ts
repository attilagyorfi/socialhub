// Error reports must not carry secrets or personal data: links in this app
// contain bearer tokens (invitations, client approvals, password resets,
// Meta deletion codes, OAuth callbacks).
const SECRET_PATH =
  /(\/(?:invite|approve|meta\/deletion|api\/approval|api\/invitation|api\/auth\/reset-password)\/)[^/?#]+/g;
const SECRET_QUERY =
  /([?&](?:token|code|state|access_token|signed_request|callbackURL)=)[^&#]*/gi;

export function scrubUrl(value: string) {
  return value
    .replace(SECRET_PATH, "$1[Filtered]")
    .replace(SECRET_QUERY, "$1[Filtered]");
}

type ScrubbableEvent = {
  request?: {
    url?: string;
    query_string?: unknown;
    cookies?: unknown;
    headers?: Record<string, string>;
    data?: unknown;
  };
  user?: Record<string, unknown>;
  breadcrumbs?: { data?: Record<string, unknown>; message?: string }[];
};

export function scrubEvent<T extends ScrubbableEvent>(event: T): T {
  if (event.request) {
    if (event.request.url) event.request.url = scrubUrl(event.request.url);
    delete event.request.query_string;
    delete event.request.cookies;
    delete event.request.data;
    if (event.request.headers)
      for (const name of Object.keys(event.request.headers))
        if (/^(cookie|authorization|x-hub-signature)/i.test(name))
          delete event.request.headers[name];
  }
  // Only the internal user id is kept, never email or IP address.
  if (event.user) event.user = event.user.id ? { id: event.user.id } : {};
  for (const crumb of event.breadcrumbs ?? []) {
    if (crumb.message) crumb.message = scrubUrl(crumb.message);
    for (const key of ["url", "to", "from"])
      if (typeof crumb.data?.[key] === "string")
        crumb.data[key] = scrubUrl(crumb.data[key] as string);
  }
  return event;
}

export function sentryOptions(dsn: string | undefined) {
  return {
    dsn,
    enabled: Boolean(dsn),
    environment:
      process.env.SENTRY_ENVIRONMENT ??
      process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ??
      "development",
    release: process.env.APP_REVISION,
    sendDefaultPii: false,
    // Errors only; performance tracing stays off to keep data minimal.
    tracesSampleRate: 0,
  };
}
