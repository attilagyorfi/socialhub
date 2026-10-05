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
    viewport: { width: 1440, height: 1000 },
    screenshot: "only-on-failure",
    trace: "off",
  },
  reporter: [["list"]],
  outputDir: ".local/e2e-results",
});
