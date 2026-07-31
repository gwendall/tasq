import { defineConfig } from "@playwright/test";
import { isAbsolute } from "node:path";

const certificateSpki = process.env.TASQ_TQ811_CERTIFICATE_SPKI;
if (!certificateSpki || !/^[A-Za-z0-9+/]{43}=$/.test(certificateSpki)) {
  throw new Error("TASQ_TQ811_CERTIFICATE_SPKI is required");
}
const outputDir = process.env.TASQ_TQ811_PLAYWRIGHT_OUTPUT;
if (!outputDir || !isAbsolute(outputDir)) {
  throw new Error("TASQ_TQ811_PLAYWRIGHT_OUTPUT must be an absolute temporary path");
}

export default defineConfig({
  testDir: "./hosted-browser",
  testMatch: "**/*.pw.ts",
  outputDir,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "line",
  timeout: 60_000,
  use: {
    browserName: "chromium",
    locale: "en-US",
    timezoneId: "UTC",
    ignoreHTTPSErrors: false,
    launchOptions: {
      args: [`--ignore-certificate-errors-spki-list=${certificateSpki}`],
    },
    trace: "off",
    screenshot: "off",
    video: "off",
  },
});
