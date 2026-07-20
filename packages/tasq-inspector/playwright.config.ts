import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./browser",
  testMatch: "**/*.pw.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "line",
  use: {
    browserName: "chromium",
    locale: "en-US",
    timezoneId: "UTC",
    trace: "retain-on-failure",
  },
});
