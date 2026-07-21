import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./browser",
  testMatch: "**/*.pw.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "line",
  webServer: {
    command: "pnpm exec next dev --hostname 127.0.0.1 --port 4317",
    url: "http://127.0.0.1:4317",
    reuseExistingServer: false,
    timeout: 120_000,
  },
  use: {
    baseURL: "http://127.0.0.1:4317",
    browserName: "chromium",
    locale: "en-US",
    timezoneId: "UTC",
    trace: "retain-on-failure",
  },
});
