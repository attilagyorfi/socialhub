import { defineConfig } from "@playwright/test";
process.loadEnvFile(".env");
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 120000,
  workers: 1,
  use: {
    baseURL: process.env.APP_URL ?? "http://localhost:3010",
    browserName: "chromium",
    channel: "chrome",
    headless: true,
    // Local Meta OAuth testing serves a self-signed certificate.
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 1000 },
    // The interface defaults to Hungarian; the suite asserts English copy.
    storageState: {
      cookies: [
        {
          name: "locale",
          value: "en",
          domain: new URL(process.env.APP_URL ?? "http://localhost:3010")
            .hostname,
          path: "/",
          expires: -1,
          httpOnly: false,
          secure: false,
          sameSite: "Lax",
        },
      ],
      origins: [],
    },
    screenshot: "only-on-failure",
    trace: "off",
  },
  reporter: [["list"]],
  outputDir: ".local/e2e-results",
});
