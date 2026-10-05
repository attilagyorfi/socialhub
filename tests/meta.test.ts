import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildMetaAuthorizationUrl,
  MetaGraphClient,
  metaConfig,
  matchMetaPublishedContent,
  normalizeMetaPostMetrics,
  normalizeMetaProfileMetrics,
  verifyMetaWebhookSignature,
  type MetaConfig,
} from "../packages/server/meta";

const config: MetaConfig = {
  appId: "app-123",
  appSecret: "secret-456",
  graphVersion: "v99.0",
  redirectUri: "https://hub.example/api/oauth/meta/callback",
  webhookVerifyToken: "verify-me",
};

function fakeFetch(
  handler: (url: URL, init: RequestInit) => unknown | Promise<unknown>,
) {
  return (async (input: URL | RequestInfo, init?: RequestInit) => {
    const value = await handler(new URL(String(input)), init ?? {});
    if (value instanceof Response) return value;
    return Response.json(value);
  }) as typeof fetch;
}

afterEach(() => {
  delete process.env.META_INTEGRATION_ENABLED;
  delete process.env.META_APP_ID;
  delete process.env.META_APP_SECRET;
  delete process.env.META_GRAPH_VERSION;
  delete process.env.META_WEBHOOK_VERIFY_TOKEN;
});

describe("Meta OAuth configuration", () => {
  it("stays fail-closed until explicitly enabled and version-pinned", () => {
    expect(() => metaConfig()).toThrowError(
      expect.objectContaining({ code: "META_DISABLED" }),
    );
    process.env.META_INTEGRATION_ENABLED = "true";
    process.env.META_APP_ID = "app";
    process.env.META_APP_SECRET = "secret";
    process.env.META_GRAPH_VERSION = "latest";
    expect(() => metaConfig()).toThrowError(
      expect.objectContaining({ code: "META_VERSION_INVALID" }),
    );
  });

  it("builds an authorization URL with state and required publishing scopes", () => {
    const url = new URL(buildMetaAuthorizationUrl(config, "opaque-state"));
    expect(url.origin).toBe("https://www.facebook.com");
    expect(url.pathname).toBe("/v99.0/dialog/oauth");
    expect(url.searchParams.get("state")).toBe("opaque-state");
    expect(url.searchParams.get("redirect_uri")).toBe(config.redirectUri);
    expect(url.searchParams.get("scope")).toContain("pages_manage_posts");
    expect(url.searchParams.get("scope")).toContain(
      "instagram_content_publish",
    );
    expect(url.searchParams.get("scope")).toContain("read_insights");
    expect(url.searchParams.get("scope")).toContain(
      "instagram_manage_insights",
    );
  });
});

describe("Meta webhook authentication", () => {
  it("accepts only the matching raw-body HMAC", () => {
    const raw = new TextEncoder().encode('{"entry":[]}');
    const signature = `sha256=${createHmac("sha256", config.appSecret)
      .update(raw)
      .digest("hex")}`;
    expect(verifyMetaWebhookSignature(raw, signature, config.appSecret)).toBe(
      true,
    );
    expect(
      verifyMetaWebhookSignature(
        new TextEncoder().encode('{"entry":[1]}'),
        signature,
        config.appSecret,
      ),
    ).toBe(false);
    expect(verifyMetaWebhookSignature(raw, null, config.appSecret)).toBe(false);
  });
});

describe("Meta Graph publishing", () => {
  it("publishes Facebook text without putting its token in the URL", async () => {
    const calls: { url: URL; init: RequestInit }[] = [];
    const graph = new MetaGraphClient(
      config,
      fakeFetch((url, init) => {
        calls.push({ url, init });
        return { id: "page_post_1" };
      }),
    );
    await expect(
      graph.publishFacebook("page-1", "page-secret-token", {
        caption: "Hello",
        link: "https://example.com",
        media: [],
      }),
    ).resolves.toEqual({ id: "page_post_1" });
    expect(calls[0].url.pathname).toBe("/v99.0/page-1/feed");
    expect(calls[0].url.toString()).not.toContain("page-secret-token");
    expect(calls[0].init.headers).toMatchObject({
      Authorization: "Bearer page-secret-token",
    });
  });

  it("creates, waits for and publishes an Instagram Reel", async () => {
    const paths: string[] = [];
    const graph = new MetaGraphClient(
      config,
      fakeFetch((url) => {
        paths.push(url.pathname);
        if (url.pathname.endsWith("/media")) return { id: "container-1" };
        if (url.pathname.endsWith("/container-1"))
          return { status_code: "FINISHED" };
        return { id: "reel-1" };
      }),
      async () => {},
    );
    await expect(
      graph.publishInstagram(
        "ig-1",
        "page-token",
        {
          caption: "Campaign",
          media: [
            {
              id: "asset-1",
              mime_type: "video/mp4",
              size_bytes: 123,
              status: "READY",
              object_key: "ready/asset-1",
            },
          ],
        },
        "https://media.example/reel.mp4",
      ),
    ).resolves.toEqual({ id: "reel-1" });
    expect(paths).toEqual([
      "/v99.0/ig-1/media",
      "/v99.0/container-1",
      "/v99.0/ig-1/media_publish",
    ]);
  });

  it("marks a network failure during publication as uncertain", async () => {
    const graph = new MetaGraphClient(config, (async () => {
      throw new Error("socket closed");
    }) as typeof fetch);
    await expect(
      graph.publishFacebook("page-1", "token", {
        caption: "Hello",
        media: [],
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "META_DELIVERY_UNCERTAIN",
    });
  });

  it("reads recent Facebook and Instagram publications without exposing tokens", async () => {
    const calls: { url: URL; init: RequestInit }[] = [];
    const graph = new MetaGraphClient(
      config,
      fakeFetch((url, init) => {
        calls.push({ url, init });
        return {
          data: url.pathname.endsWith("/published_posts")
            ? [
                {
                  id: "page_post_1",
                  message: "Campaign",
                  created_time: "2026-09-30T10:00:00Z",
                  permalink_url: "https://facebook.example/post-1",
                },
              ]
            : [
                {
                  id: "ig_media_1",
                  caption: "Campaign",
                  timestamp: "2026-09-30T10:00:00Z",
                  permalink: "https://instagram.example/media-1",
                },
              ],
        };
      }),
    );
    await expect(
      graph.getPublishedContent("facebook", "page-1", "secret-token"),
    ).resolves.toEqual([
      {
        id: "page_post_1",
        caption: "Campaign",
        createdAt: "2026-09-30T10:00:00Z",
        permalink: "https://facebook.example/post-1",
      },
    ]);
    await expect(
      graph.getPublishedContent("instagram", "ig-1", "secret-token"),
    ).resolves.toHaveLength(1);
    expect(calls.map((call) => call.url.pathname)).toEqual([
      "/v99.0/page-1/published_posts",
      "/v99.0/ig-1/media",
    ]);
    expect(calls.every((call) => !call.url.toString().includes("secret-token"))).toBe(
      true,
    );
    expect(calls[0].init.headers).toMatchObject({
      Authorization: "Bearer secret-token",
    });
  });

  it("reads granted permissions through the authorization header", async () => {
    const calls: { url: URL; init: RequestInit }[] = [];
    const graph = new MetaGraphClient(
      config,
      fakeFetch((url, init) => {
        calls.push({ url, init });
        return {
          data: [
            { permission: "pages_manage_posts", status: "granted" },
            { permission: "ads_management", status: "declined" },
            { permission: 7, status: "granted" },
          ],
        };
      }),
    );
    await expect(graph.getPermissions("secret-token")).resolves.toEqual([
      { permission: "pages_manage_posts", status: "granted" },
      { permission: "ads_management", status: "declined" },
    ]);
    expect(calls[0].url.pathname).toBe("/v99.0/me/permissions");
    expect(calls[0].url.toString()).not.toContain("secret-token");
    expect(calls[0].init.headers).toMatchObject({
      Authorization: "Bearer secret-token",
    });
  });

  it("reconciles only one exact caption in the delivery time window", () => {
    const input = {
      caption: "Campaign\r\n#launch",
      startedAt: "2026-09-30T10:00:00Z",
      finishedAt: "2026-09-30T10:00:30Z",
    };
    expect(
      matchMetaPublishedContent(
        [
          {
            id: "match",
            caption: "Campaign\n#launch",
            createdAt: "2026-09-30T10:01:00Z",
          },
          {
            id: "wrong-caption",
            caption: "Another campaign",
            createdAt: "2026-09-30T10:01:00Z",
          },
          {
            id: "too-late",
            caption: "Campaign\n#launch",
            createdAt: "2026-09-30T10:06:00Z",
          },
        ],
        input,
      ),
    ).toEqual([
      {
        id: "match",
        caption: "Campaign\n#launch",
        createdAt: "2026-09-30T10:01:00Z",
      },
    ]);
  });
});

describe("Meta analytics mapping", () => {
  it("maps current Facebook media-view metrics to the normalized model", () => {
    expect(
      normalizeMetaProfileMetrics(
        "facebook",
        { followers_count: 900 },
        {
          data: [
            { name: "page_follows", values: [{ value: 1234 }] },
            { name: "page_media_view", values: [{ value: 8000 }] },
            {
              name: "page_total_media_view_unique",
              values: [{ value: 5100 }],
            },
            { name: "page_post_engagements", values: [{ value: 320 }] },
          ],
        },
      ),
    ).toEqual({
      followers: 1234,
      reach: 5100,
      impressions: 8000,
      engagement: 320,
    });
  });

  it("maps Instagram totals and nested post counters", () => {
    expect(
      normalizeMetaProfileMetrics(
        "instagram",
        { followers_count: "700" },
        {
          data: [
            { name: "reach", total_value: { value: 1200 } },
            { name: "views", total_value: { value: 2400 } },
            { name: "total_interactions", total_value: { value: 180 } },
          ],
        },
      ),
    ).toEqual({
      followers: 700,
      reach: 1200,
      impressions: 2400,
      engagement: 180,
    });
    expect(
      normalizeMetaPostMetrics(
        "facebook",
        {
          likes: { summary: { total_count: 11 } },
          comments: { summary: { total_count: 4 } },
          shares: { count: 3 },
        },
        {
          data: [
            { name: "post_media_view", values: [{ value: 600 }] },
            {
              name: "post_total_media_view_unique",
              values: [{ value: 450 }],
            },
          ],
        },
      ),
    ).toEqual({
      likes: 11,
      comments: 4,
      shares: 3,
      views: 600,
      reach: 450,
      impressions: 600,
      saves: 0,
    });
  });

  it("sends insight tokens in headers instead of URLs", async () => {
    const calls: { url: URL; init: RequestInit }[] = [];
    const graph = new MetaGraphClient(
      config,
      fakeFetch((url, init) => {
        calls.push({ url, init });
        return { data: [] };
      }),
    );
    await graph.getInsights("page-1", "analytics-secret", ["page_media_view"]);
    expect(calls[0].url.pathname).toBe("/v99.0/page-1/insights");
    expect(calls[0].url.searchParams.get("metric")).toBe("page_media_view");
    expect(calls[0].url.toString()).not.toContain("analytics-secret");
    expect(calls[0].init.headers).toMatchObject({
      Authorization: "Bearer analytics-secret",
    });
  });
});
