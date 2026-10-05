import {
  capabilities,
  validatePost,
  type Platform,
  type Content,
} from "./domain";
import { AppError } from "./security";
export interface SocialProvider {
  connectAccount(name: string): Promise<{ remoteId: string; name: string }>;
  disconnectAccount(remoteId: string): Promise<void>;
  refreshCredentials(): Promise<{ expiresAt: string }>;
  validatePost(content: Content): string[];
  getCapabilities(): string[];
  publishPost(
    content: Content,
    key: string,
    attempt: number,
  ): Promise<{ remoteId: string }>;
  deletePost(remoteId: string): Promise<void>;
  getPostStatus(remoteId: string): Promise<string>;
  fetchPostMetrics(remoteId: string): Promise<Record<string, number>>;
  fetchProfileMetrics(
    remoteId: string,
    day: string,
  ): Promise<Record<string, number>>;
  fetchComments(remoteId: string): Promise<{ id: string; body: string }[]>;
  handleWebhook(payload: unknown): Promise<{ accepted: boolean }>;
}
export type ReceiptStore = {
  get(key: string): Promise<string | undefined>;
  put(key: string, remoteId: string): Promise<string>;
};
export class MockProvider implements SocialProvider {
  constructor(
    public platform: Platform,
    private receipts: ReceiptStore,
  ) {}
  async connectAccount(name: string) {
    return { remoteId: `mock-${crypto.randomUUID()}`, name };
  }
  async disconnectAccount(_remoteId: string) {}
  async refreshCredentials() {
    return { expiresAt: new Date(Date.now() + 90 * 86400000).toISOString() };
  }
  validatePost(content: Content) {
    return validatePost(this.platform, content);
  }
  getCapabilities() {
    return capabilities[this.platform];
  }
  async publishPost(content: Content, key: string, attempt: number) {
    const prior = await this.receipts.get(key);
    if (prior) return { remoteId: prior };
    const errors = this.validatePost(content);
    if (errors.length) throw new AppError(422, "VALIDATION", errors.join(" "));
    await new Promise((r) => setTimeout(r, 150));
    if (content.caption.includes("[mock:fail]"))
      throw new AppError(
        422,
        "MOCK_REJECTED",
        "Simulated permanent provider rejection",
      );
    if (content.caption.includes("[mock:rate-limit]") && attempt < 3)
      throw new AppError(429, "RATE_LIMIT", "Simulated provider rate limit");
    return {
      remoteId: await this.receipts.put(key, `mock-${this.platform}-${key}`),
    };
  }
  async deletePost(_remoteId: string) {}
  async getPostStatus(_remoteId: string) {
    return "PUBLISHED";
  }
  async fetchPostMetrics(remoteId: string) {
    const n = [...remoteId].reduce((a, c) => a + c.charCodeAt(0), 0);
    return {
      likes: (n % 200) + 12,
      comments: n % 20,
      shares: n % 15,
      views: (n % 2000) + 300,
      reach: (n % 1300) + 200,
      impressions: (n % 2500) + 400,
    };
  }
  async fetchProfileMetrics(remoteId: string, day: string) {
    const n = [...(remoteId + day)].reduce((a, c) => a + c.charCodeAt(0), 0);
    return {
      followers: 1200 + (n % 700),
      reach: 500 + (n % 900),
      impressions: 800 + (n % 1400),
      engagement: 30 + (n % 90),
    };
  }
  async fetchComments(_remoteId: string) {
    return [];
  }
  async handleWebhook(_payload: unknown) {
    return { accepted: true };
  }
}
export class DirectProvider implements SocialProvider {
  constructor(public platform: Platform) {}
  private unavailable(): never {
    throw new AppError(
      503,
      "PROVIDER_NOT_CONFIGURED",
      `${this.platform} direct integration requires an approved application and completed API implementation. Use mock mode.`,
    );
  }
  async connectAccount(
    _name: string,
  ): Promise<{ remoteId: string; name: string }> {
    return this.unavailable();
  }
  async disconnectAccount(_id: string): Promise<void> {
    this.unavailable();
  }
  async refreshCredentials(): Promise<{ expiresAt: string }> {
    return this.unavailable();
  }
  validatePost(content: Content) {
    return validatePost(this.platform, content);
  }
  getCapabilities() {
    return capabilities[this.platform];
  }
  async publishPost(
    _content: Content,
    _key: string,
    _attempt: number,
  ): Promise<{ remoteId: string }> {
    return this.unavailable();
  }
  async deletePost(_id: string): Promise<void> {
    this.unavailable();
  }
  async getPostStatus(_id: string): Promise<string> {
    return this.unavailable();
  }
  async fetchPostMetrics(_id: string): Promise<Record<string, number>> {
    return this.unavailable();
  }
  async fetchProfileMetrics(
    _id: string,
    _day: string,
  ): Promise<Record<string, number>> {
    return this.unavailable();
  }
  async fetchComments(_id: string): Promise<{ id: string; body: string }[]> {
    return this.unavailable();
  }
  async handleWebhook(_payload: unknown): Promise<{ accepted: boolean }> {
    return this.unavailable();
  }
}
export class FacebookProvider extends DirectProvider {
  constructor() {
    super("facebook");
  }
}
export class InstagramProvider extends DirectProvider {
  constructor() {
    super("instagram");
  }
}
export class LinkedInProvider extends DirectProvider {
  constructor() {
    super("linkedin");
  }
}
export class TikTokProvider extends DirectProvider {
  constructor() {
    super("tiktok");
  }
}
export class GoogleBusinessProvider extends DirectProvider {
  constructor() {
    super("google");
  }
}
export function provider(
  platform: Platform,
  receipts: ReceiptStore,
  mode = process.env.SOCIAL_PROVIDER_MODE ?? "mock",
): SocialProvider {
  if (mode === "mock") return new MockProvider(platform, receipts);
  if (mode === "direct") return new DirectProvider(platform);
  throw new AppError(
    503,
    "PROVIDER_NOT_CONFIGURED",
    "Ayrshare is not enabled in this build.",
  );
}
