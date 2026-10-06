import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { pool } from "../db";
import { AppError, decrypt, encrypt, hashToken, token } from "../core/security";
import { validatePost, type Content, type Platform } from "../core/domain";
import type { Context } from "./context";
import { audit, transaction } from "./transaction";
import {
  assertStoredObject,
  instagramImageObjectKey,
  signedObjectUrl,
} from "./media";

const META_SCOPES = [
  "pages_show_list",
  // Pages owned by a business portfolio are missing from me/accounts without it.
  "business_management",
  "pages_read_engagement",
  "pages_manage_posts",
  "read_insights",
  "instagram_basic",
  "instagram_content_publish",
  "instagram_manage_insights",
] as const;

export type MetaConfig = {
  appId: string;
  appSecret: string;
  graphVersion: string;
  redirectUri: string;
  webhookVerifyToken?: string;
  // Facebook Login for Business configuration; replaces the scope list.
  loginConfigId?: string;
};

export function metaIntegrationStatus() {
  const version = process.env.META_GRAPH_VERSION?.trim();
  const configured = Boolean(
    process.env.META_INTEGRATION_ENABLED === "true" &&
      process.env.META_APP_ID &&
      process.env.META_APP_SECRET &&
      version &&
      /^v\d+\.\d+$/.test(version),
  );
  return { enabled: configured };
}

export function metaConfig(): MetaConfig {
  if (process.env.META_INTEGRATION_ENABLED !== "true")
    throw new AppError(
      503,
      "META_DISABLED",
      "Meta integration is not enabled.",
    );
  const appId = process.env.META_APP_ID?.trim();
  const appSecret = process.env.META_APP_SECRET?.trim();
  const graphVersion = process.env.META_GRAPH_VERSION?.trim();
  if (!appId || !appSecret || !graphVersion)
    throw new AppError(
      503,
      "META_NOT_CONFIGURED",
      "Meta application credentials and API version are required.",
    );
  if (!/^v\d+\.\d+$/.test(graphVersion))
    throw new AppError(
      503,
      "META_VERSION_INVALID",
      "META_GRAPH_VERSION must use the vNN.N format.",
    );
  const loginConfigId = process.env.META_LOGIN_CONFIG_ID?.trim() || undefined;
  if (loginConfigId && !/^\d+$/.test(loginConfigId))
    throw new AppError(
      503,
      "META_LOGIN_CONFIG_INVALID",
      "META_LOGIN_CONFIG_ID must be the numeric Facebook Login for Business configuration ID.",
    );
  const appUrl = new URL(process.env.APP_URL ?? "http://localhost:3010");
  return {
    appId,
    appSecret,
    graphVersion,
    redirectUri: new URL("/api/oauth/meta/callback", appUrl).toString(),
    webhookVerifyToken: process.env.META_WEBHOOK_VERIFY_TOKEN?.trim(),
    loginConfigId,
  };
}

export function buildMetaAuthorizationUrl(config: MetaConfig, state: string) {
  const url = new URL(
    `https://www.facebook.com/${config.graphVersion}/dialog/oauth`,
  );
  url.search = new URLSearchParams({
    client_id: config.appId,
    redirect_uri: config.redirectUri,
    state,
    response_type: "code",
    // Business apps grant permissions through a saved login configuration;
    // Meta recommends not sending scope alongside it.
    ...(config.loginConfigId
      ? { config_id: config.loginConfigId }
      : { scope: META_SCOPES.join(",") }),
  }).toString();
  return url.toString();
}

type GraphErrorPayload = {
  error?: {
    message?: string;
    type?: string;
    code?: number;
    error_subcode?: number;
    is_transient?: boolean;
    fbtrace_id?: string;
  };
};

// Meta's numeric error identifiers are safe to log and essential for
// diagnosing permission or configuration problems; messages are not kept.
export type MetaProviderError = {
  status: number;
  code?: number;
  subcode?: number;
  type?: string;
  traceId?: string;
};

export function metaProviderError(error: unknown) {
  return error instanceof AppError
    ? (error as AppError & { provider?: MetaProviderError }).provider
    : undefined;
}

function graphError(response: Response, payload: GraphErrorPayload) {
  return Object.assign(classifyGraphError(response, payload), {
    provider: {
      status: response.status,
      code: payload.error?.code,
      subcode: payload.error?.error_subcode,
      type: payload.error?.type,
      traceId: payload.error?.fbtrace_id,
    } satisfies MetaProviderError,
  });
}

function classifyGraphError(response: Response, payload: GraphErrorPayload) {
  const error = payload.error;
  const code = error?.code;
  if (response.status === 429 || [4, 17, 32, 613].includes(code ?? -1))
    return new AppError(429, "META_RATE_LIMIT", "Meta rate limit reached.");
  if (response.status === 401 || code === 190)
    return new AppError(
      401,
      "META_TOKEN_INVALID",
      "The Meta authorization is no longer valid.",
    );
  if (error?.is_transient || response.status >= 500)
    return new AppError(
      503,
      "META_UNAVAILABLE",
      "Meta is temporarily unavailable.",
    );
  return new AppError(
    422,
    "META_REJECTED",
    "Meta rejected the request. Check the account permissions and content.",
  );
}

function uncertainDelivery() {
  return new AppError(
    409,
    "META_DELIVERY_UNCERTAIN",
    "Meta did not confirm whether the content was published. Review the account before retrying.",
  );
}

type FetchLike = typeof fetch;

export type MetaPublishedContent = {
  id: string;
  caption: string;
  createdAt: string;
  permalink?: string;
};

export class MetaGraphClient {
  private readonly base: string;

  constructor(
    private readonly config: MetaConfig,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly wait: (milliseconds: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {
    this.base = `https://graph.facebook.com/${config.graphVersion}`;
  }

  private async request<T>(
    path: string,
    options: {
      method?: "GET" | "POST" | "DELETE";
      token?: string;
      params?: Record<string, string>;
      delivery?: boolean;
    } = {},
  ): Promise<T> {
    const method = options.method ?? "GET";
    const params = new URLSearchParams(options.params);
    const url = new URL(`${this.base}/${path.replace(/^\//, "")}`);
    const init: RequestInit = {
      method,
      headers: {
        Accept: "application/json",
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      },
      signal: AbortSignal.timeout(30_000),
    };
    if (method === "GET") url.search = params.toString();
    else {
      (init.headers as Record<string, string>)["Content-Type"] =
        "application/x-www-form-urlencoded";
      init.body = params;
    }
    let response: Response;
    try {
      response = await this.fetchImpl(url, init);
    } catch {
      if (options.delivery) throw uncertainDelivery();
      throw new AppError(
        503,
        "META_UNAVAILABLE",
        "Meta is temporarily unavailable.",
      );
    }
    const payload = (await response.json().catch(() => ({}))) as T &
      GraphErrorPayload;
    if (!response.ok || payload.error) {
      const error = graphError(response, payload);
      // A server-side failure after a mutation may still have published the
      // content, so it must not be retried blindly.
      if (options.delivery && error.code === "META_UNAVAILABLE")
        throw uncertainDelivery();
      throw error;
    }
    return payload;
  }

  async exchangeCode(code: string) {
    const payload = await this.request<{
      access_token?: string;
      expires_in?: number;
    }>("oauth/access_token", {
      method: "POST",
      params: {
        client_id: this.config.appId,
        client_secret: this.config.appSecret,
        redirect_uri: this.config.redirectUri,
        code,
      },
    });
    if (!payload.access_token)
      throw new AppError(
        502,
        "META_RESPONSE_INVALID",
        "Meta returned an invalid token response.",
      );
    return {
      accessToken: payload.access_token,
      expiresAt: payload.expires_in
        ? new Date(Date.now() + payload.expires_in * 1000)
        : undefined,
    };
  }

  async exchangeLongLived(shortToken: string) {
    const payload = await this.request<{
      access_token?: string;
      expires_in?: number;
    }>("oauth/access_token", {
      method: "POST",
      params: {
        grant_type: "fb_exchange_token",
        client_id: this.config.appId,
        client_secret: this.config.appSecret,
        fb_exchange_token: shortToken,
      },
    });
    if (!payload.access_token)
      throw new AppError(
        502,
        "META_RESPONSE_INVALID",
        "Meta returned an invalid long-lived token response.",
      );
    return {
      accessToken: payload.access_token,
      expiresAt: payload.expires_in
        ? new Date(Date.now() + payload.expires_in * 1000)
        : undefined,
    };
  }

  async getUser(accessToken: string) {
    const result = await this.request<{ id?: string }>("me", {
      token: accessToken,
      params: { fields: "id" },
    });
    if (!result.id)
      throw new AppError(
        502,
        "META_RESPONSE_INVALID",
        "Meta did not return a user identifier.",
      );
    return result.id;
  }

  async getPermissions(accessToken: string) {
    const result = await this.request<{
      data?: { permission?: unknown; status?: unknown }[];
    }>("me/permissions", { token: accessToken });
    if (!Array.isArray(result.data))
      throw new AppError(
        502,
        "META_RESPONSE_INVALID",
        "Meta returned an invalid permission list.",
      );
    return result.data.flatMap((item) =>
      typeof item.permission === "string" && typeof item.status === "string"
        ? [{ permission: item.permission, status: item.status }]
        : [],
    );
  }

  getFields<T>(objectId: string, accessToken: string, fields: string) {
    return this.request<T>(objectId, {
      token: accessToken,
      params: { fields },
    });
  }

  getInsights(
    objectId: string,
    accessToken: string,
    metrics: readonly string[],
    params: Record<string, string> = {},
  ) {
    return this.request<MetaInsightsResponse>(`${objectId}/insights`, {
      token: accessToken,
      params: { metric: metrics.join(","), ...params },
    });
  }

  async getPublishedContent(
    platform: "facebook" | "instagram",
    objectId: string,
    accessToken: string,
  ): Promise<MetaPublishedContent[]> {
    const result = await this.request<{
      data?: {
        id?: unknown;
        message?: unknown;
        caption?: unknown;
        created_time?: unknown;
        timestamp?: unknown;
        permalink_url?: unknown;
        permalink?: unknown;
      }[];
    }>(
      platform === "facebook"
        ? `${objectId}/published_posts`
        : `${objectId}/media`,
      {
        token: accessToken,
        params: {
          fields:
            platform === "facebook"
              ? "id,message,created_time,permalink_url"
              : "id,caption,timestamp,permalink",
          limit: "100",
        },
      },
    );
    if (!Array.isArray(result.data))
      throw new AppError(
        502,
        "META_RESPONSE_INVALID",
        "Meta returned an invalid publication list.",
      );
    return result.data.flatMap((item) => {
      const id = typeof item.id === "string" ? item.id : "";
      const createdAt =
        typeof item.created_time === "string"
          ? item.created_time
          : typeof item.timestamp === "string"
            ? item.timestamp
            : "";
      if (!id || !createdAt || !Number.isFinite(new Date(createdAt).getTime()))
        return [];
      const caption =
        typeof item.message === "string"
          ? item.message
          : typeof item.caption === "string"
            ? item.caption
            : "";
      const permalink =
        typeof item.permalink_url === "string"
          ? item.permalink_url
          : typeof item.permalink === "string"
            ? item.permalink
            : undefined;
      return [{ id, caption, createdAt, permalink }];
    });
  }

  async getPages(accessToken: string) {
    const pages: MetaPage[] = [];
    let after: string | undefined;
    for (let page = 0; page < 10; page++) {
      const result = await this.request<{
        data?: MetaPage[];
        paging?: { cursors?: { after?: string }; next?: string };
      }>("me/accounts", {
        token: accessToken,
        params: {
          fields:
            "id,name,access_token,tasks,picture{url},instagram_business_account{id,username,name,profile_picture_url}",
          limit: "100",
          ...(after ? { after } : {}),
        },
      });
      if (!Array.isArray(result.data))
        throw new AppError(
          502,
          "META_RESPONSE_INVALID",
          "Meta returned an invalid Page list.",
        );
      pages.push(...result.data.filter(isMetaPage));
      after = result.paging?.next ? result.paging.cursors?.after : undefined;
      if (!after) break;
    }
    return pages;
  }

  publishFacebook(
    pageId: string,
    accessToken: string,
    content: Content & { media: MetaMedia[] },
    mediaUrl?: string,
  ) {
    const media = content.media[0];
    if (!media)
      return this.request<{ id?: string }>(`${pageId}/feed`, {
        method: "POST",
        token: accessToken,
        delivery: true,
        params: {
          message: content.caption,
          ...(content.link ? { link: content.link } : {}),
        },
      });
    if (media.mime_type.startsWith("image/"))
      return this.request<{ id?: string }>(`${pageId}/photos`, {
        method: "POST",
        token: accessToken,
        delivery: true,
        params: {
          url: mediaUrl!,
          caption: content.caption,
          published: "true",
        },
      });
    return this.request<{ id?: string }>(`${pageId}/videos`, {
      method: "POST",
      token: accessToken,
      delivery: true,
      params: { file_url: mediaUrl!, description: content.caption },
    });
  }

  async publishInstagram(
    instagramId: string,
    accessToken: string,
    content: Content & { media: MetaMedia[] },
    mediaUrl: string,
  ) {
    const media = content.media[0]!;
    const video = media.mime_type.startsWith("video/");
    const container = await this.request<{ id?: string }>(
      `${instagramId}/media`,
      {
        method: "POST",
        token: accessToken,
        delivery: true,
        params: {
          ...(video
            ? { media_type: "REELS", video_url: mediaUrl }
            : { image_url: mediaUrl }),
          caption: content.caption,
        },
      },
    );
    if (!container.id)
      throw new AppError(
        502,
        "META_RESPONSE_INVALID",
        "Meta did not return an Instagram container.",
      );
    for (let check = 0; check < 10; check++) {
      const status = await this.request<{
        status_code?: string;
        status?: string;
      }>(container.id, {
        token: accessToken,
        params: { fields: "status_code,status" },
      });
      if (status.status_code === "FINISHED") break;
      if (["ERROR", "EXPIRED"].includes(status.status_code ?? ""))
        throw new AppError(
          422,
          "META_MEDIA_REJECTED",
          "Instagram could not process the media.",
        );
      if (check === 9)
        throw new AppError(
          409,
          "META_DELIVERY_UNCERTAIN",
          "Instagram media processing did not finish in time. Review the account before retrying.",
        );
      await this.wait(1000);
    }
    return this.request<{ id?: string }>(`${instagramId}/media_publish`, {
      method: "POST",
      token: accessToken,
      delivery: true,
      params: { creation_id: container.id },
    });
  }

  revokeUserGrant(userAccessToken: string) {
    return this.request<{ success?: boolean }>("me/permissions", {
      method: "DELETE",
      token: userAccessToken,
    });
  }
}

type MetaPage = {
  id: string;
  name: string;
  access_token: string;
  tasks?: string[];
  picture?: { data?: { url?: string } };
  instagram_business_account?: {
    id: string;
    username?: string;
    name?: string;
    profile_picture_url?: string;
  };
};

function isMetaPage(value: MetaPage) {
  return Boolean(
    value &&
      typeof value.id === "string" &&
      typeof value.name === "string" &&
      typeof value.access_token === "string",
  );
}

type MetaCredential = {
  version: 1;
  grantId: string;
  userAccessToken: string;
  pageAccessToken: string;
  pageId: string;
  instagramBusinessId?: string;
};

export type MetaInsightsResponse = {
  data?: {
    name?: string;
    values?: { value?: unknown; end_time?: string }[];
    total_value?: { value?: unknown } | unknown;
  }[];
};

function metricNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (Array.isArray(value))
    return value.reduce<number>((sum, item) => sum + metricNumber(item), 0);
  if (value && typeof value === "object")
    return Object.values(value).reduce<number>(
      (sum, item) => sum + metricNumber(item),
      0,
    );
  return 0;
}

function insightValue(insights: MetaInsightsResponse, name: string) {
  const metric = insights.data?.find((item) => item.name === name);
  if (!metric) return 0;
  if (metric.total_value !== undefined)
    return metricNumber(
      typeof metric.total_value === "object" &&
        metric.total_value !== null &&
        "value" in metric.total_value
        ? metric.total_value.value
        : metric.total_value,
    );
  return metricNumber(metric.values?.at(-1)?.value);
}

export function normalizeMetaProfileMetrics(
  platform: "facebook" | "instagram",
  fields: { followers_count?: unknown },
  insights: MetaInsightsResponse,
) {
  if (platform === "facebook")
    return {
      followers:
        insightValue(insights, "page_follows") ||
        metricNumber(fields.followers_count),
      reach: insightValue(insights, "page_total_media_view_unique"),
      impressions: insightValue(insights, "page_media_view"),
      engagement: insightValue(insights, "page_post_engagements"),
    };
  return {
    followers: metricNumber(fields.followers_count),
    reach: insightValue(insights, "reach"),
    impressions: insightValue(insights, "views"),
    engagement: insightValue(insights, "total_interactions"),
  };
}

type MetaPostFields = {
  like_count?: unknown;
  comments_count?: unknown;
  shares?: unknown;
  likes?: { summary?: { total_count?: unknown } };
  comments?: { summary?: { total_count?: unknown } };
};

export function normalizeMetaPostMetrics(
  platform: "facebook" | "instagram",
  fields: MetaPostFields,
  insights: MetaInsightsResponse,
) {
  const likes = metricNumber(
    fields.like_count ?? fields.likes?.summary?.total_count,
  );
  const comments = metricNumber(
    fields.comments_count ?? fields.comments?.summary?.total_count,
  );
  const shares =
    metricNumber(fields.shares) || insightValue(insights, "shares");
  if (platform === "facebook") {
    const views = insightValue(insights, "post_media_view");
    return {
      likes,
      comments,
      shares,
      views,
      reach: insightValue(insights, "post_total_media_view_unique"),
      impressions: views,
      saves: 0,
    };
  }
  const views = insightValue(insights, "views");
  return {
    likes: likes || insightValue(insights, "likes"),
    comments: comments || insightValue(insights, "comments"),
    shares,
    views,
    reach: insightValue(insights, "reach"),
    impressions: views,
    saves: insightValue(insights, "saved"),
  };
}

type MetaMedia = Content["media"][number] & { object_key: string };

const facebookCapabilities = [
  "TEXT_POST",
  "IMAGE_POST",
  "VIDEO",
  "LINK_POST",
  "HASHTAGS",
  "SCHEDULING",
];
const instagramCapabilities = [
  "IMAGE_POST",
  "VIDEO",
  "SHORT_VIDEO",
  "HASHTAGS",
  "SCHEDULING",
];

export async function startMetaOAuth(c: Context) {
  const config = metaConfig();
  const state = token();
  await transaction(async (tx) => {
    await tx.query(
      "DELETE FROM oauth_states WHERE expires_at<=now() OR (user_id=$1 AND provider='meta')",
      [c.userId],
    );
    await tx.query(
      "INSERT INTO oauth_states(organization_id,client_id,user_id,provider,state_hash,expires_at) VALUES($1,$2,$3,'meta',$4,now()+interval '10 minutes')",
      [c.organizationId, c.clientId, c.userId, hashToken(state)],
    );
  });
  return { url: buildMetaAuthorizationUrl(config, state) };
}

function credentialScope(
  organizationId: string,
  clientId: string,
  accountId: string,
) {
  return `${organizationId}:${clientId}:${accountId}`;
}

function decodeCredential(
  encryptedValue: string,
  organizationId: string,
  clientId: string,
  accountId: string,
): MetaCredential {
  try {
    const value = JSON.parse(
      decrypt(
        encryptedValue,
        credentialScope(organizationId, clientId, accountId),
      ),
    ) as MetaCredential;
    if (
      value.version !== 1 ||
      !value.grantId ||
      !value.userAccessToken ||
      !value.pageAccessToken ||
      !value.pageId
    )
      throw new Error("invalid credential");
    return value;
  } catch {
    throw new AppError(
      503,
      "META_CREDENTIAL_INVALID",
      "The stored Meta credential is invalid. Reconnect the account.",
    );
  }
}

async function upsertMetaAccount(
  tx: import("pg").PoolClient,
  c: Context,
  input: {
    platform: "facebook" | "instagram";
    name: string;
    remoteId: string;
    avatar?: string;
    credential: MetaCredential;
    expiresAt?: Date;
  },
) {
  const account = (
    await tx.query(
      `INSERT INTO social_accounts(organization_id,client_id,platform,name,remote_id,mode,status,token_health,capabilities,avatar,last_sync_at)
       VALUES($1,$2,$3,$4,$5,'direct','CONNECTED','HEALTHY',$6,$7,now())
       ON CONFLICT(organization_id,client_id,platform,mode,remote_id) WHERE deleted_at IS NULL
       DO UPDATE SET name=excluded.name,status='CONNECTED',token_health='HEALTHY',capabilities=excluded.capabilities,avatar=excluded.avatar,updated_at=now()
       RETURNING *`,
      [
        c.organizationId,
        c.clientId,
        input.platform,
        input.name,
        input.remoteId,
        JSON.stringify(
          input.platform === "facebook"
            ? facebookCapabilities
            : instagramCapabilities,
        ),
        input.avatar ?? null,
      ],
    )
  ).rows[0];
  const sealed = encrypt(
    JSON.stringify(input.credential),
    credentialScope(c.organizationId, c.clientId, account.id),
  );
  await tx.query(
    `INSERT INTO social_credentials(organization_id,client_id,social_account_id,encrypted_value,expires_at)
     VALUES($1,$2,$3,$4,$5)
     ON CONFLICT(social_account_id) DO UPDATE SET encrypted_value=excluded.encrypted_value,expires_at=excluded.expires_at,updated_at=now()`,
    [c.organizationId, c.clientId, account.id, sealed, input.expiresAt ?? null],
  );
  await audit(tx, c, "social_account.connected", account.id, {
    platform: input.platform,
    mode: "direct",
  });
  return account;
}

export async function completeMetaOAuth(
  c: Context,
  code: string,
  graph = new MetaGraphClient(metaConfig()),
) {
  const short = await graph.exchangeCode(code);
  const long = await graph.exchangeLongLived(short.accessToken);
  const [grantId, pages] = await Promise.all([
    graph.getUser(long.accessToken),
    graph.getPages(long.accessToken),
  ]);
  const manageable = pages.filter(
    (page) =>
      !page.tasks ||
      page.tasks.includes("CREATE_CONTENT") ||
      page.tasks.includes("MANAGE"),
  );
  if (!manageable.length) {
    console.error(
      JSON.stringify({
        event: "meta_no_pages",
        pagesReturned: pages.length,
        tasks: [...new Set(pages.flatMap((page) => page.tasks ?? []))],
      }),
    );
    throw new AppError(
      422,
      "META_NO_PAGES",
      "No Facebook Page with content publishing access was found.",
    );
  }
  return transaction(async (tx) => {
    const accounts = [];
    for (const page of manageable) {
      const credential: MetaCredential = {
        version: 1,
        grantId,
        userAccessToken: long.accessToken,
        pageAccessToken: page.access_token,
        pageId: page.id,
        instagramBusinessId: page.instagram_business_account?.id,
      };
      accounts.push(
        await upsertMetaAccount(tx, c, {
          platform: "facebook",
          name: page.name,
          remoteId: page.id,
          avatar: page.picture?.data?.url,
          credential,
          expiresAt: long.expiresAt,
        }),
      );
      const instagram = page.instagram_business_account;
      if (instagram)
        accounts.push(
          await upsertMetaAccount(tx, c, {
            platform: "instagram",
            name: instagram.username ?? instagram.name ?? page.name,
            remoteId: instagram.id,
            avatar: instagram.profile_picture_url,
            credential,
            expiresAt: long.expiresAt,
          }),
        );
    }
    return { connected: accounts.length };
  });
}

async function loadMetaCredential(
  organizationId: string,
  clientId: string,
  accountId: string,
) {
  const row = (
    await pool.query(
      `SELECT a.*,c.encrypted_value,c.expires_at
       FROM social_accounts a JOIN social_credentials c ON c.social_account_id=a.id
       WHERE a.organization_id=$1 AND a.client_id=$2 AND a.id=$3
        AND a.mode='direct' AND a.platform IN ('facebook','instagram')
        AND a.status='CONNECTED' AND a.deleted_at IS NULL`,
      [organizationId, clientId, accountId],
    )
  ).rows[0];
  if (!row)
    throw new AppError(
      422,
      "META_ACCOUNT_UNAVAILABLE",
      "The Meta account is not connected.",
    );
  if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now())
    throw new AppError(
      401,
      "META_TOKEN_EXPIRED",
      "The Meta authorization expired. Reconnect the account.",
    );
  return {
    account: row,
    credential: decodeCredential(
      row.encrypted_value,
      organizationId,
      clientId,
      accountId,
    ),
  };
}

export async function verifyMetaAccountAccess(
  input: { organizationId: string; clientId: string; accountId: string },
  graph = new MetaGraphClient(metaConfig()),
) {
  const { account, credential } = await loadMetaCredential(
    input.organizationId,
    input.clientId,
    input.accountId,
  );
  const platform = account.platform as "facebook" | "instagram";
  const objectId =
    platform === "facebook"
      ? credential.pageId
      : credential.instagramBusinessId;
  if (!objectId)
    throw new AppError(
      422,
      "META_INSTAGRAM_INVALID",
      "The Instagram professional account is no longer available.",
    );
  const [identity, permissions, publications] = await Promise.all([
    graph.getFields<{ id?: unknown; name?: unknown; username?: unknown }>(
      objectId,
      credential.pageAccessToken,
      platform === "facebook" ? "id,name" : "id,username,name",
    ),
    graph.getPermissions(credential.userAccessToken),
    graph.getPublishedContent(
      platform,
      objectId,
      credential.pageAccessToken,
    ),
  ]);
  const granted = new Set(
    permissions
      .filter((permission) => permission.status === "granted")
      .map((permission) => permission.permission),
  );
  return {
    platform,
    objectId,
    identity: {
      id: typeof identity.id === "string" ? identity.id : null,
      name:
        typeof identity.name === "string"
          ? identity.name
          : typeof identity.username === "string"
            ? identity.username
            : null,
    },
    permissions: META_SCOPES.map((permission) => ({
      permission,
      granted: granted.has(permission),
    })),
    recentPublicationCount: publications.length,
  };
}

function nextIsoDay(day: string) {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function normalizedPublishedCaption(value: string) {
  return value.replace(/\r\n/g, "\n").trim();
}

export function matchMetaPublishedContent(
  candidates: MetaPublishedContent[],
  input: { caption: string; startedAt: Date | string; finishedAt: Date | string },
) {
  const start = new Date(input.startedAt).getTime() - 5 * 60_000;
  const end = new Date(input.finishedAt).getTime() + 5 * 60_000;
  const caption = normalizedPublishedCaption(input.caption);
  return candidates.filter((candidate) => {
    const created = new Date(candidate.createdAt).getTime();
    return (
      created >= start &&
      created <= end &&
      normalizedPublishedCaption(candidate.caption) === caption
    );
  });
}

export async function findMetaPublishedMatches(
  input: {
    organizationId: string;
    clientId: string;
    accountId: string;
    caption: string;
    startedAt: Date | string;
    finishedAt: Date | string;
  },
  graph = new MetaGraphClient(metaConfig()),
) {
  const { account, credential } = await loadMetaCredential(
    input.organizationId,
    input.clientId,
    input.accountId,
  );
  const platform = account.platform as "facebook" | "instagram";
  const objectId =
    platform === "facebook"
      ? credential.pageId
      : credential.instagramBusinessId;
  if (!objectId)
    throw new AppError(
      422,
      "META_INSTAGRAM_INVALID",
      "The Instagram professional account is no longer available.",
    );
  const candidates = await graph.getPublishedContent(
    platform,
    objectId,
    credential.pageAccessToken,
  );
  return matchMetaPublishedContent(candidates, input);
}

export async function fetchMetaProfileMetrics(
  input: {
    organizationId: string;
    clientId: string;
    accountId: string;
    day: string;
  },
  graph = new MetaGraphClient(metaConfig()),
) {
  const { account, credential } = await loadMetaCredential(
    input.organizationId,
    input.clientId,
    input.accountId,
  );
  const platform = account.platform as "facebook" | "instagram";
  const objectId =
    platform === "facebook"
      ? credential.pageId
      : credential.instagramBusinessId;
  if (!objectId)
    throw new AppError(
      422,
      "META_INSTAGRAM_INVALID",
      "The Instagram professional account is no longer available.",
    );
  const token = credential.pageAccessToken;
  const metrics =
    platform === "facebook"
      ? [
          "page_follows",
          "page_media_view",
          "page_total_media_view_unique",
          "page_post_engagements",
        ]
      : ["reach", "views", "total_interactions"];
  const [fields, insights] = await Promise.all([
    graph.getFields<{ followers_count?: unknown }>(
      objectId,
      token,
      "followers_count",
    ),
    graph.getInsights(objectId, token, metrics, {
      since: input.day,
      until: nextIsoDay(input.day),
      period: "day",
      ...(platform === "instagram" ? { metric_type: "total_value" } : {}),
    }),
  ]);
  return {
    raw: { fields, insights, mapping: "meta-media-views-2026-06" },
    normalized: normalizeMetaProfileMetrics(platform, fields, insights),
  };
}

export async function fetchMetaPostMetrics(
  input: {
    organizationId: string;
    clientId: string;
    accountId: string;
    remoteId: string;
  },
  graph = new MetaGraphClient(metaConfig()),
) {
  const { account, credential } = await loadMetaCredential(
    input.organizationId,
    input.clientId,
    input.accountId,
  );
  const platform = account.platform as "facebook" | "instagram";
  const token = credential.pageAccessToken;
  const fieldsQuery =
    platform === "facebook"
      ? "likes.limit(0).summary(true),comments.limit(0).summary(true),shares"
      : "like_count,comments_count";
  const metrics =
    platform === "facebook"
      ? ["post_media_view", "post_total_media_view_unique"]
      : ["views", "reach", "likes", "comments", "shares", "saved"];
  const [fields, insights] = await Promise.all([
    graph.getFields<MetaPostFields>(input.remoteId, token, fieldsQuery),
    graph.getInsights(input.remoteId, token, metrics),
  ]);
  return {
    raw: { fields, insights, mapping: "meta-media-views-2026-06" },
    normalized: normalizeMetaPostMetrics(platform, fields, insights),
  };
}

function assertPublicMediaUrl(value: string) {
  const host = new URL(value).hostname;
  if (["localhost", "127.0.0.1", "::1"].includes(host))
    throw new AppError(
      422,
      "META_MEDIA_NOT_PUBLIC",
      "Meta cannot download media from a local storage URL. Configure a public S3 endpoint.",
    );
}

export async function publishMeta(input: {
  organizationId: string;
  clientId: string;
  accountId: string;
  platform: Platform;
  content: Content & { media: MetaMedia[] };
  idempotencyKey: string;
}) {
  const prior = (
    await pool.query(
      "SELECT remote_id FROM provider_receipts WHERE idempotency_key=$1 AND organization_id=$2 AND client_id=$3 AND provider=$4",
      [
        input.idempotencyKey,
        input.organizationId,
        input.clientId,
        `meta:${input.platform}`,
      ],
    )
  ).rows[0]?.remote_id;
  if (prior) return { remoteId: prior };
  const errors = validatePost(input.platform, input.content);
  if (errors.length) throw new AppError(422, "VALIDATION", errors.join(" "));
  if (!["facebook", "instagram"].includes(input.platform))
    throw new AppError(
      503,
      "PROVIDER_NOT_CONFIGURED",
      "Direct provider is not configured.",
    );
  if (input.content.media.length > 1)
    throw new AppError(
      422,
      "META_MEDIA_UNSUPPORTED",
      "This Meta connection currently supports one media attachment per post.",
    );
  const { credential } = await loadMetaCredential(
    input.organizationId,
    input.clientId,
    input.accountId,
  );
  const media = input.content.media[0];
  if (media) await assertStoredObject(media.object_key);
  const objectKey =
    media &&
    input.platform === "instagram" &&
    media.mime_type.startsWith("image/")
      ? await instagramImageObjectKey({
          ...media,
          organization_id: input.organizationId,
          client_id: input.clientId,
        })
      : media?.object_key;
  const url = objectKey ? await signedObjectUrl(objectKey, 900) : undefined;
  if (url) assertPublicMediaUrl(url);
  const graph = new MetaGraphClient(metaConfig());
  if (
    input.platform === "instagram" &&
    (!credential.instagramBusinessId || !url)
  )
    throw new AppError(
      422,
      "META_INSTAGRAM_INVALID",
      "The Instagram account or media attachment is unavailable.",
    );
  const result =
    input.platform === "facebook"
      ? await graph.publishFacebook(
          credential.pageId,
          credential.pageAccessToken,
          input.content,
          url,
        )
      : await graph.publishInstagram(
          credential.instagramBusinessId!,
          credential.pageAccessToken,
          input.content,
          url!,
        );
  // The mutation succeeded at HTTP level, so the content may be live.
  if (!result.id) throw uncertainDelivery();
  const inserted = (
    await pool.query(
      `INSERT INTO provider_receipts(idempotency_key,organization_id,client_id,provider,remote_id)
       VALUES($1,$2,$3,$4,$5)
       ON CONFLICT(idempotency_key) DO NOTHING
       RETURNING remote_id`,
      [
        input.idempotencyKey,
        input.organizationId,
        input.clientId,
        `meta:${input.platform}`,
        result.id,
      ],
    )
  ).rows[0]?.remote_id;
  if (inserted) return { remoteId: inserted };
  const concurrent = (
    await pool.query(
      "SELECT remote_id FROM provider_receipts WHERE idempotency_key=$1 AND organization_id=$2 AND client_id=$3 AND provider=$4",
      [
        input.idempotencyKey,
        input.organizationId,
        input.clientId,
        `meta:${input.platform}`,
      ],
    )
  ).rows[0]?.remote_id;
  if (!concurrent)
    throw new AppError(
      409,
      "PROVIDER_RECEIPT_CONFLICT",
      "The provider receipt does not match this publication.",
    );
  return { remoteId: concurrent };
}

export async function disconnectMeta(c: Context, accountId: string) {
  const selected = await loadMetaCredential(
    c.organizationId,
    c.clientId,
    accountId,
  );
  const graph = new MetaGraphClient(metaConfig());
  const revoked = await graph.revokeUserGrant(
    selected.credential.userAccessToken,
  );
  if (!revoked.success)
    throw new AppError(
      409,
      "META_REVOCATION_FAILED",
      "Meta did not confirm permission revocation.",
    );
  const candidates = (
    await pool.query(
      `SELECT a.id,c.encrypted_value FROM social_accounts a
       JOIN social_credentials c ON c.social_account_id=a.id
       WHERE a.organization_id=$1 AND a.client_id=$2 AND a.mode='direct'
        AND a.platform IN ('facebook','instagram') AND a.deleted_at IS NULL`,
      [c.organizationId, c.clientId],
    )
  ).rows;
  const ids = candidates
    .filter((row) => {
      try {
        return (
          decodeCredential(
            row.encrypted_value,
            c.organizationId,
            c.clientId,
            row.id,
          ).grantId === selected.credential.grantId
        );
      } catch {
        return false;
      }
    })
    .map((row) => row.id);
  await transaction(async (tx) => {
    await tx.query(
      "UPDATE social_accounts SET status='DISCONNECTED',token_health='REVOKED',updated_at=now() WHERE organization_id=$1 AND client_id=$2 AND id=ANY($3::uuid[])",
      [c.organizationId, c.clientId, ids],
    );
    await tx.query(
      `DELETE FROM analytics_sync_jobs
       WHERE social_account_id=ANY($1::uuid[]) AND status<>'DONE'`,
      [ids],
    );
    await tx.query(
      `DELETE FROM publish_reconciliation_jobs
       WHERE status IN ('PENDING','RETRY','RUNNING')
         AND publish_job_id IN (
           SELECT j.id FROM publish_jobs j
           JOIN post_targets t ON t.id=j.target_id
           WHERE t.social_account_id=ANY($1::uuid[])
         )`,
      [ids],
    );
    await tx.query(
      "DELETE FROM social_credentials WHERE organization_id=$1 AND client_id=$2 AND social_account_id=ANY($3::uuid[])",
      [c.organizationId, c.clientId, ids],
    );
    for (const id of ids)
      await audit(tx, c, "social_account.disconnected", id, {
        provider: "meta",
        grantRevoked: true,
      });
  });
  return { disconnected: ids.length };
}

export function verifyMetaWebhookSignature(
  rawBody: Uint8Array,
  signature: string | null,
  appSecret: string,
) {
  if (!signature?.startsWith("sha256=")) return false;
  const receivedHex = signature.slice(7);
  if (!/^[a-f0-9]{64}$/i.test(receivedHex)) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest();
  const received = Buffer.from(receivedHex, "hex");
  return (
    received.length === expected.length && timingSafeEqual(received, expected)
  );
}

export async function ingestMetaWebhook(payload: unknown) {
  const body = payload as {
    object?: string;
    entry?: { id?: string; time?: number; changes?: unknown[] }[];
  };
  if (!Array.isArray(body.entry))
    throw new AppError(
      422,
      "META_WEBHOOK_INVALID",
      "Invalid Meta webhook payload.",
    );
  if (body.entry.length > 100)
    throw new AppError(
      413,
      "META_WEBHOOK_TOO_LARGE",
      "Meta webhook contains too many entries.",
    );
  let stored = 0;
  for (const entry of body.entry) {
    if (!entry.id || !Array.isArray(entry.changes)) continue;
    if (entry.changes.length > 100)
      throw new AppError(
        413,
        "META_WEBHOOK_TOO_LARGE",
        "Meta webhook contains too many changes.",
      );
    const accounts = (
      await pool.query(
        `SELECT id,organization_id,client_id FROM social_accounts
         WHERE remote_id=$1 AND mode='direct' AND platform IN ('facebook','instagram')
          AND status='CONNECTED' AND deleted_at IS NULL`,
        [entry.id],
      )
    ).rows;
    for (const account of accounts) {
      for (let index = 0; index < entry.changes.length; index++) {
        const change = entry.changes[index] as { field?: string };
        const digest = createHash("sha256")
          .update(
            JSON.stringify({
              accountId: account.id,
              object: body.object,
              entryId: entry.id,
              time: entry.time,
              index,
              change,
            }),
          )
          .digest("hex");
        const result = await pool.query(
          `INSERT INTO webhook_events(organization_id,client_id,social_account_id,provider,external_id,event_type,payload,status,signature_valid)
           VALUES($1,$2,$3,'meta',$4,$5,$6,'PENDING',true)
           ON CONFLICT(provider,external_id) DO NOTHING`,
          [
            account.organization_id,
            account.client_id,
            account.id,
            digest,
            change?.field ?? body.object ?? "unknown",
            JSON.stringify({ object: body.object, entryId: entry.id, change }),
          ],
        );
        stored += result.rowCount ?? 0;
      }
    }
  }
  return { stored };
}

export async function refreshDueMetaCredentials(limit = 20) {
  if (!metaIntegrationStatus().enabled) return { refreshed: 0, failed: 0 };
  const rows = (
    await pool.query(
      `SELECT a.id,a.organization_id,a.client_id,c.encrypted_value,c.expires_at
       FROM social_accounts a JOIN social_credentials c ON c.social_account_id=a.id
       WHERE a.mode='direct' AND a.platform IN ('facebook','instagram')
        AND a.status='CONNECTED' AND a.deleted_at IS NULL
        AND c.expires_at IS NOT NULL AND c.expires_at<now()+interval '7 days'
       ORDER BY c.expires_at LIMIT $1`,
      [limit],
    )
  ).rows;
  let refreshed = 0,
    failed = 0;
  for (const row of rows) {
    try {
      const old = decodeCredential(
        row.encrypted_value,
        row.organization_id,
        row.client_id,
        row.id,
      );
      const graph = new MetaGraphClient(metaConfig());
      const next = await graph.exchangeLongLived(old.userAccessToken);
      const pages = await graph.getPages(next.accessToken);
      const page = pages.find((candidate) => candidate.id === old.pageId);
      if (!page)
        throw new AppError(
          401,
          "META_PAGE_ACCESS_LOST",
          "Page access is no longer available.",
        );
      const credential: MetaCredential = {
        ...old,
        userAccessToken: next.accessToken,
        pageAccessToken: page.access_token,
        instagramBusinessId: page.instagram_business_account?.id,
      };
      await pool.query(
        `UPDATE social_credentials SET encrypted_value=$1,expires_at=$2,updated_at=now()
         WHERE organization_id=$3 AND client_id=$4 AND social_account_id=$5`,
        [
          encrypt(
            JSON.stringify(credential),
            credentialScope(row.organization_id, row.client_id, row.id),
          ),
          next.expiresAt ?? row.expires_at,
          row.organization_id,
          row.client_id,
          row.id,
        ],
      );
      await pool.query(
        "UPDATE social_accounts SET token_health='HEALTHY',updated_at=now() WHERE id=$1",
        [row.id],
      );
      refreshed++;
    } catch {
      await pool.query(
        "UPDATE social_accounts SET token_health=$1,updated_at=now() WHERE id=$2",
        [
          new Date(row.expires_at).getTime() <= Date.now()
            ? "EXPIRED"
            : "ERROR",
          row.id,
        ],
      );
      failed++;
    }
  }
  return { refreshed, failed };
}
