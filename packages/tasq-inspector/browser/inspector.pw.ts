import { test, expect } from "@playwright/test";
import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

let directory: string;
let server: ChildProcessWithoutNullStreams;
let baseUrl: string;
let primaryId: string;
const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const cli = resolve(here, "../../tasq-cli/src/index.ts");

async function runCli(args: string[]): Promise<string> {
  const result = await execFileAsync("bun", ["run", cli, ...args], {
    env: { ...process.env, HOME: directory, TASQ_DB_URL: "" },
  });
  return result.stdout;
}

function waitForStartup(child: ChildProcessWithoutNullStreams): Promise<string> {
  return new Promise((resolveStartup, reject) => {
    let output = "";
    const onData = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) {
        child.stdout.off("data", onData);
        resolveStartup(match[0]);
      }
    };
    child.stdout.on("data", onData);
    child.once("exit", (code) => reject(new Error(`tasq web exited before startup (${code})`)));
    child.stderr.once("data", (chunk) => reject(new Error(chunk.toString("utf8"))));
  });
}

test.beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "tasq-inspector-browser-"));
  const common = ["--tenant", "inspection/browser", "--actor", "browser-fixture", "--json"];
  const primary = JSON.parse(await runCli([
    "add", "Verify robotic arm calibration",
    "--description", "Audit the external condition before releasing the workcell.",
    "--priority", "5", ...common,
  ])) as { id: string };
  primaryId = primary.id;
  const running = JSON.parse(await runCli([
    "add", "Run collision envelope simulation", "--priority", "3", ...common,
  ])) as { id: string };
  await runCli(["start", running.id, ...common]);
  const blocked = JSON.parse(await runCli([
    "add", "Reserve shared workcell", "--priority", "4", ...common,
  ])) as { id: string };
  await runCli(["block", blocked.id, "--reason", "Awaiting the current lease holder", ...common]);
  server = spawn("bun", [
    "run", cli, "web", "--tenant", "inspection/browser", "--host", "127.0.0.1", "--port", "0",
  ], {
    env: { ...process.env, HOME: directory, TASQ_DB_URL: "" },
  });
  baseUrl = await waitForStartup(server);
});

test.afterAll(async () => {
  if (server.exitCode === null) {
    server.kill("SIGTERM");
    await new Promise<void>((resolveExit) => server.once("exit", () => resolveExit()));
  }
  rmSync(directory, { recursive: true, force: true });
});

test("desktop Console is keyboard-readable, filterable and contains no mutation surface", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(baseUrl);
  await expect(page).toHaveTitle(/Tasq Console/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Workspace overview");
  await expect(page.locator("[data-filter-row]")).toHaveCount(3);
  await expect(page.locator('form[method="post"], textarea')).toHaveCount(0);
  await expect(page.getByText("Local and read-only", { exact: true })).toBeVisible();

  await page.keyboard.press("Tab");
  await expect(page.locator(".skip-link")).toBeFocused();
  await page.getByLabel("Filter this loaded page").fill("collision");
  await expect(page.locator("[data-filter-row]:visible")).toHaveCount(1);
  await expect(page.getByRole("status").filter({ hasText: "Showing 1 of 3" })).toBeVisible();
  const bodyOverflow = await page.locator("body").evaluate((body) => body.scrollWidth > body.clientWidth);
  expect(bodyOverflow).toBe(false);
  if (process.env.TASQ_INSPECTOR_SCREENSHOT_DIR) {
    await page.screenshot({
      path: join(process.env.TASQ_INSPECTOR_SCREENSHOT_DIR, "desktop-light.png"),
      fullPage: true,
    });
  }
});

test("legacy filters and detail navigation preserve deep commitment inspection", async ({ page }) => {
  await page.goto(`${baseUrl}/inspector`);
  await page.getByLabel("Title contains").fill("calibration");
  await page.getByRole("button", { name: "Apply filter" }).click();
  await expect(page).toHaveURL(/\/inspector\?q=calibration/);
  await expect(page.locator(".commitment-row")).toHaveCount(1);
  await page.getByRole("link", { name: "Verify robotic arm calibration" }).click();
  await expect(page).toHaveURL(`${baseUrl}/commitments/${primaryId}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Verify robotic arm calibration");
  await expect(page.locator("#waits").getByRole("heading", { name: "Waits and facts" })).toBeVisible();
  await expect(page.locator("#effects").getByRole("heading", { name: "Effects and authority" })).toBeVisible();
  await expect(page.locator("#execution").getByRole("heading", { name: "Execution and proof" })).toBeVisible();
  await expect(page.locator("#audit").getByRole("heading", { name: "Ordered audit" })).toBeVisible();
  await expect(page.locator("script, form, button, textarea")).toHaveCount(0);
  if (process.env.TASQ_INSPECTOR_SCREENSHOT_DIR) {
    await page.screenshot({
      path: join(process.env.TASQ_INSPECTOR_SCREENSHOT_DIR, "detail-light.png"),
      fullPage: true,
    });
  }
});

test("narrow and dark Console rendering remain contained and legible", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(baseUrl);
  const colors = await page.locator("body").evaluate((body) => {
    const style = getComputedStyle(body);
    return { background: style.backgroundColor, color: style.color };
  });
  expect(colors.background).toBe("rgb(11, 17, 24)");
  expect(colors.color).toBe("rgb(232, 238, 245)");
  const bodyOverflow = await page.locator("body").evaluate((body) => body.scrollWidth > body.clientWidth);
  expect(bodyOverflow).toBe(false);
  const tableCellDisplay = await page.locator(".data-table td").first().evaluate((cell) => getComputedStyle(cell).display);
  expect(tableCellDisplay).toBe("grid");
  const touchHeight = await page.getByRole("link", { name: "Work", exact: true }).evaluate((link) => link.getBoundingClientRect().height);
  expect(touchHeight).toBeGreaterThanOrEqual(44);
  if (process.env.TASQ_INSPECTOR_SCREENSHOT_DIR) {
    await page.screenshot({
      path: join(process.env.TASQ_INSPECTOR_SCREENSHOT_DIR, "mobile-dark.png"),
      fullPage: true,
    });
  }
});

test("live changes become explicit and refresh the canonical server view", async ({ page }) => {
  await page.goto(baseUrl);
  await expect(page.locator("#live-status")).toHaveText("Live connection");
  await runCli([
    "add", "Inspect new live calibration evidence", "--priority", "2",
    "--tenant", "inspection/browser", "--actor", "browser-fixture", "--json",
  ]);
  await expect(page.locator("#live-status")).toHaveText("Changes available");
  const refresh = page.getByRole("button", { name: "Refresh canonical view" });
  await expect(refresh).toBeVisible();
  await refresh.click();
  await expect(page.getByRole("link", { name: "Inspect new live calibration evidence" })).toBeVisible();
});

test("support bundle is previewed before its download is enabled", async ({ page }) => {
  await page.goto(baseUrl);
  const download = page.getByRole("link", { name: "Download reviewed JSON" });
  await expect(download).toBeHidden();
  await page.getByRole("button", { name: "Preview bundle" }).click();
  await expect(page.locator("#support-preview")).toBeVisible();
  await expect(download).toBeVisible();
  const preview = await page.locator("#support-preview pre").textContent();
  expect(preview).toContain('"contractVersion": "tasq.console-support-bundle.v1"');
  expect(preview).toContain('"event_payloads"');
  expect(preview).not.toContain("Foreign workspace secret");
  const reviewedDownload = await download.evaluate(async (link) => {
    const response = await fetch((link as HTMLAnchorElement).href);
    return response.text();
  });
  expect(reviewedDownload).toBe(preview);
  const bypass = await page.request.get(`${baseUrl}/api/console/support-bundle?download=1`);
  expect(bypass.status()).toBe(400);
});

test("HTTP mutation remains impossible through a browser context", async ({ request }) => {
  for (const method of ["post", "put", "patch", "delete"] as const) {
    const response = await request[method](`${baseUrl}/api/index`);
    expect(response.status()).toBe(405);
    expect(response.headers().allow).toBe("GET, HEAD");
  }
});
