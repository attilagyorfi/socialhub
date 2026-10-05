import { describe, expect, it } from "vitest";
import { metaStagingPreflight } from "../packages/server/meta-staging";

describe("Meta staging preflight", () => {
  it("rejects local URLs and incomplete provider configuration", () => {
    const checks = metaStagingPreflight({
      APP_URL: "http://localhost:3010",
      S3_PUBLIC_ENDPOINT: "http://127.0.0.1:9000",
      META_INTEGRATION_ENABLED: "false",
    });
    expect(checks.every((check) => !check.ok)).toBe(true);
  });

  it("accepts a complete public staging configuration without exposing values", () => {
    const checks = metaStagingPreflight({
      APP_URL: "https://staging.example.test",
      S3_PUBLIC_ENDPOINT: "https://media-staging.example.test",
      META_INTEGRATION_ENABLED: "true",
      META_APP_ID: "configured",
      META_APP_SECRET: "configured",
      META_GRAPH_VERSION: "v26.0",
      META_WEBHOOK_VERIFY_TOKEN: "configured",
      META_STAGING_ACCOUNT_ID: "123e4567-e89b-42d3-a456-426614174000",
    });
    expect(checks.every((check) => check.ok)).toBe(true);
    expect(JSON.stringify(checks)).not.toContain("media-staging.example.test");
  });
});
