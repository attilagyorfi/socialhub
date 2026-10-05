import { pool } from "../db";
import {
  fetchMetaPostMetrics,
  fetchMetaProfileMetrics,
  metaIntegrationStatus,
  verifyMetaAccountAccess,
} from "./meta";

export type StagingCheck = {
  name: string;
  ok: boolean;
  detail: string;
};

type StagingEnvironment = Readonly<Record<string, string | undefined>>;

function publicHttps(value: string | undefined) {
  if (!value) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !["localhost", "127.0.0.1", "::1"].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

export function metaStagingPreflight(
  environment: StagingEnvironment = process.env,
): StagingCheck[] {
  return [
    {
      name: "meta-integration",
      ok:
        environment.META_INTEGRATION_ENABLED === "true" &&
        Boolean(environment.META_APP_ID) &&
        Boolean(environment.META_APP_SECRET) &&
        /^v\d+\.\d+$/.test(environment.META_GRAPH_VERSION ?? ""),
      detail: "Meta is enabled with an app ID, secret and pinned Graph version.",
    },
    {
      name: "webhook-token",
      ok: Boolean(environment.META_WEBHOOK_VERIFY_TOKEN),
      detail: "A Meta webhook verification token is configured.",
    },
    {
      name: "public-app-url",
      ok: publicHttps(environment.APP_URL),
      detail: "APP_URL is a public HTTPS origin usable for OAuth and webhooks.",
    },
    {
      name: "public-media-url",
      ok: publicHttps(environment.S3_PUBLIC_ENDPOINT),
      detail: "S3_PUBLIC_ENDPOINT is public HTTPS for Meta media downloads.",
    },
    {
      name: "staging-account",
      ok: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        environment.META_STAGING_ACCOUNT_ID ?? "",
      ),
      detail: "META_STAGING_ACCOUNT_ID selects the connected staging account.",
    },
  ];
}

export async function runMetaStagingVerification(
  environment: StagingEnvironment = process.env,
) {
  const checks = metaStagingPreflight(environment);
  if (checks.some((check) => !check.ok))
    return { ok: false, phase: "preflight", checks };

  const accountId = environment.META_STAGING_ACCOUNT_ID!;
  const account = (
    await pool.query(
      `SELECT id,organization_id,client_id,platform
       FROM social_accounts
       WHERE id=$1 AND mode='direct' AND status='CONNECTED'
         AND platform IN ('facebook','instagram') AND deleted_at IS NULL`,
      [accountId],
    )
  ).rows[0];
  if (!account) {
    checks.push({
      name: "connected-account",
      ok: false,
      detail: "The selected direct Meta account is not connected.",
    });
    return { ok: false, phase: "account", checks };
  }

  const access = await verifyMetaAccountAccess({
    organizationId: account.organization_id,
    clientId: account.client_id,
    accountId: account.id,
  });
  const missingPermissions = access.permissions
    .filter((permission) => !permission.granted)
    .map((permission) => permission.permission);
  checks.push(
    {
      name: "account-identity",
      ok: access.identity.id === access.objectId,
      detail: access.identity.name
        ? `Connected ${access.platform} identity is readable.`
        : `Connected ${access.platform} identity has no readable name.`,
    },
    {
      name: "permissions",
      ok: missingPermissions.length === 0,
      detail: missingPermissions.length
        ? `Missing granted permissions: ${missingPermissions.join(", ")}.`
        : "All required Meta permissions are granted.",
    },
    {
      name: "publication-list",
      ok: true,
      detail: `Recent provider publications are readable (${access.recentPublicationCount} returned).`,
    },
  );

  const day = new Date().toISOString().slice(0, 10);
  const profileMetrics = await fetchMetaProfileMetrics({
    organizationId: account.organization_id,
    clientId: account.client_id,
    accountId: account.id,
    day,
  });
  checks.push({
    name: "profile-insights",
    ok: true,
    detail: `Current ${access.platform} profile insights are readable and normalized.`,
  });

  const published = (
    await pool.query(
      `SELECT t.remote_id,t.published_at
       FROM post_targets t
       JOIN publish_jobs j ON j.target_id=t.id
       JOIN provider_receipts r ON r.idempotency_key=j.idempotency_key
       WHERE t.social_account_id=$1 AND t.status='PUBLISHED'
         AND t.remote_id IS NOT NULL AND r.remote_id=t.remote_id
         AND r.provider=$2
         AND t.published_at>now()-interval '7 days'
       ORDER BY t.published_at DESC LIMIT 1`,
      [account.id, `meta:${account.platform}`],
    )
  ).rows[0];
  if (!published) {
    checks.push({
      name: "publish-pipeline",
      ok: false,
      detail:
        "No receipt-backed Meta publication from the last seven days was found for this account.",
    });
    return {
      ok: false,
      phase: "publishing",
      account: { id: account.id, platform: account.platform },
      normalizedProfileMetricNames: Object.keys(profileMetrics.normalized),
      checks,
    };
  }

  const postMetrics = await fetchMetaPostMetrics({
    organizationId: account.organization_id,
    clientId: account.client_id,
    accountId: account.id,
    remoteId: published.remote_id,
  });
  checks.push(
    {
      name: "publish-pipeline",
      ok: true,
      detail: "A recent app-published target has matching durable Meta evidence.",
    },
    {
      name: "post-insights",
      ok: true,
      detail: "Published-post insights are readable and normalized.",
    },
  );
  return {
    ok: checks.every((check) => check.ok),
    phase: "complete",
    account: { id: account.id, platform: account.platform },
    normalizedProfileMetricNames: Object.keys(profileMetrics.normalized),
    normalizedPostMetricNames: Object.keys(postMetrics.normalized),
    checks,
  };
}

export function configuredMetaStagingStatus() {
  return {
    integration: metaIntegrationStatus(),
    checks: metaStagingPreflight(),
  };
}
