import { test, expect } from "@playwright/test";
import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "console-fixture.ts");
const scenarioNames = ["empty", "mature", "hostile", "corrupt", "large"] as const;
type Scenario = (typeof scenarioNames)[number];
type RunningFixture = { process: ChildProcessWithoutNullStreams; directory: string; url: string };

const fixtures = new Map<Scenario, RunningFixture>();

function waitForStartup(child: ChildProcessWithoutNullStreams, scenario: Scenario): Promise<string> {
  return new Promise((resolveStartup, reject) => {
    let output = "";
    const onData = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      const line = output.split("\n").find((candidate) => candidate.startsWith("{"));
      if (!line) return;
      const announcement = JSON.parse(line) as { scenario: Scenario; url: string; now: number };
      if (announcement.scenario !== scenario || announcement.now !== 1_735_689_600_000) {
        reject(new Error(`invalid ${scenario} fixture announcement`));
        return;
      }
      child.stdout.off("data", onData);
      resolveStartup(announcement.url);
    };
    child.stdout.on("data", onData);
    child.once("exit", (code) => reject(new Error(`${scenario} fixture exited before startup (${code})`)));
    child.stderr.once("data", (chunk) => reject(new Error(chunk.toString("utf8"))));
  });
}

async function startFixture(scenario: Scenario): Promise<RunningFixture> {
  const directory = mkdtempSync(join(tmpdir(), `tasq-console-${scenario}-`));
  const child = spawn("bun", ["run", fixture, "serve", scenario, directory], {
    env: { PATH: process.env.PATH ?? "", NO_COLOR: "1" },
  });
  const url = await waitForStartup(child, scenario);
  return { process: child, directory, url };
}

async function mutate(scenario: Scenario): Promise<void> {
  const running = fixtures.get(scenario);
  if (!running) throw new Error(`fixture is not running: ${scenario}`);
  await execFileAsync("bun", ["run", fixture, "mutate", scenario, running.directory], {
    env: { PATH: process.env.PATH ?? "", NO_COLOR: "1" },
  });
}

function url(scenario: Scenario): string {
  const value = fixtures.get(scenario)?.url;
  if (!value) throw new Error(`fixture URL is unavailable: ${scenario}`);
  return value;
}

test.beforeAll(async () => {
  for (const scenario of scenarioNames) fixtures.set(scenario, await startFixture(scenario));
});

test.afterAll(async () => {
  for (const running of fixtures.values()) {
    if (running.process.exitCode === null) {
      running.process.kill("SIGTERM");
      await new Promise<void>((resolveExit) => running.process.once("exit", () => resolveExit()));
    }
    rmSync(running.directory, { recursive: true, force: true });
  }
  fixtures.clear();
});

test("empty workspace explains absence without inventing history or failure", async ({ page }) => {
  const response = await page.goto(url("empty"));
  expect(response?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Workspace overview");
  await expect(page.getByRole("heading", { name: "No records in this view" })).toBeVisible();
  await expect(page.getByText("No active commitments are present in this bounded page.")).toBeVisible();
  await expect(page.locator(".attention-clear")).toHaveText("No bounded attention signals at this snapshot.");
  await expect(page.locator(".metric-strip div").filter({ hasText: "Active work" }).locator("dd")).toHaveText("0");
  await page.getByRole("link", { name: "Actors", exact: true }).click();
  await expect(page.locator("[data-filter-row]")).toHaveCount(1);
  await page.getByRole("link", { name: "Audit", exact: true }).click();
  await expect(page.getByRole("heading", { name: "No audit events" })).toBeVisible();
});

test("mature desktop Console is keyboard-readable, bounded and read-only", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(url("mature"));
  await expect(page).toHaveTitle(/Tasq Console/);
  await expect(page.locator("[data-filter-row]")).toHaveCount(3);
  await expect(page.locator('form[method="post"], textarea')).toHaveCount(0);
  await expect(page.getByText("Local and read-only", { exact: true })).toBeVisible();

  await page.keyboard.press("Tab");
  await expect(page.locator(".skip-link")).toBeFocused();
  await page.getByLabel("Filter this loaded page").fill("collision");
  await expect(page.locator("[data-filter-row]:visible")).toHaveCount(1);
  await expect(page.getByRole("status").filter({ hasText: "Showing 1 of 3" })).toBeVisible();
  expect(await page.locator("body").evaluate((body) => body.scrollWidth > body.clientWidth)).toBe(false);
});

test("mature navigation reaches deep detail, claims and resources", async ({ page }) => {
  await page.goto(`${url("mature")}/inspector?q=calibration`);
  await expect(page.locator(".commitment-row")).toHaveCount(1);
  await page.getByRole("link", { name: "Verify robotic arm calibration" }).click();
  await expect(page).toHaveURL(/\/commitments\/[0-9a-f-]{36}$/);
  await expect(page.locator("#waits").getByRole("heading", { name: "Waits and facts" })).toBeVisible();
  await expect(page.locator("#effects").getByRole("heading", { name: "Effects and authority" })).toBeVisible();
  await expect(page.locator("#execution").getByRole("heading", { name: "Execution and proof" })).toBeVisible();
  await expect(page.locator("#audit").getByRole("heading", { name: "Ordered audit" })).toBeVisible();
  await expect(page.locator("script, form, button, textarea")).toHaveCount(0);

  await page.goto(`${url("mature")}/?view=claims`);
  await expect(page.locator("[data-filter-row]")).toHaveCount(1);
  await expect(page.getByRole("cell", { name: "active" }).locator(".state-badge")).toBeVisible();
  await page.goto(`${url("mature")}/?view=resources`);
  await expect(page.getByText("robot:arm-a", { exact: true })).toBeVisible();
});

test("narrow dark Console remains contained, legible and reduced-motion safe", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(url("mature"));
  const colors = await page.locator("body").evaluate((body) => {
    const style = getComputedStyle(body);
    return { background: style.backgroundColor, color: style.color };
  });
  expect(colors).toEqual({ background: "rgb(11, 17, 24)", color: "rgb(232, 238, 245)" });
  expect(await page.locator("body").evaluate((body) => body.scrollWidth > body.clientWidth)).toBe(false);
  expect(await page.locator(".data-table td").first().evaluate((cell) => getComputedStyle(cell).display)).toBe("grid");
  expect(await page.getByRole("link", { name: "Work", exact: true }).evaluate((link) => link.getBoundingClientRect().height))
    .toBeGreaterThanOrEqual(44);
});

test("live invalidation observes a fixed-clock external writer", async ({ page }) => {
  await page.goto(url("mature"));
  await expect(page.locator("#live-status")).toHaveText("Live connection");
  await mutate("mature");
  await expect(page.locator("#live-status")).toHaveText("Changes available");
  const refresh = page.getByRole("button", { name: "Refresh canonical view" });
  await refresh.click();
  await expect(page.getByRole("link", { name: "Inspect new live calibration evidence" })).toBeVisible();
});

test("support bundle is previewed exactly and browser mutation stays impossible", async ({ page, request }) => {
  await page.goto(url("mature"));
  const download = page.getByRole("link", { name: "Download reviewed JSON" });
  await expect(download).toBeHidden();
  await page.getByRole("button", { name: "Preview bundle" }).click();
  await expect(page.locator("#support-preview")).toBeVisible();
  await expect(download).toBeVisible();
  const preview = await page.locator("#support-preview pre").textContent();
  expect(preview).toContain('"contractVersion": "tasq.console-support-bundle.v1"');
  expect(preview).toContain('"event_payloads"');
  const reviewedDownload = await download.evaluate(async (link) => {
    const response = await fetch((link as HTMLAnchorElement).href);
    return response.text();
  });
  expect(reviewedDownload).toBe(preview);
  for (const method of ["post", "put", "patch", "delete"] as const) {
    const response = await request[method](`${url("mature")}/api/index`);
    expect(response.status()).toBe(405);
    expect(response.headers().allow).toBe("GET, HEAD");
  }
});

test("hostile actor data stays inert and private metadata stays redacted", async ({ page }) => {
  let dialogOpened = false;
  page.on("dialog", async (dialog) => {
    dialogOpened = true;
    await dialog.dismiss();
  });
  await page.goto(url("hostile"));
  await expect(page.locator("[data-filter-row]")).toHaveCount(1);
  await expect(page.getByText("<script>globalThis.__tasqPwned=true</script><img src=x onerror=alert(1)>", { exact: true }))
    .toBeVisible();
  expect(await page.locator("img").count()).toBe(0);
  expect(await page.evaluate(() => (globalThis as typeof globalThis & { __tasqPwned?: boolean }).__tasqPwned)).toBeUndefined();
  expect(dialogOpened).toBe(false);
  await page.getByRole("button", { name: "Preview bundle" }).click();
  const preview = await page.locator("#support-preview pre").textContent();
  expect(preview).not.toContain("Foreign workspace secret");
  const apiBody = await (await page.request.get(`${url("hostile")}/api/console/support-bundle`)).text();
  expect(apiBody).not.toContain("Foreign workspace secret");
});

test("corrupt canonical state fails closed with a bounded operator error", async ({ page }) => {
  const response = await page.goto(url("corrupt"));
  expect(response?.status()).toBe(500);
  await expect(page.getByRole("heading", { name: "This read could not be completed." })).toBeVisible();
  await expect(page.getByText("The inspector could not build this read projection.")).toBeVisible();
  const body = await page.locator("body").textContent();
  expect(body).not.toContain("alien");
  expect(body).not.toContain("SQLITE");
  expect(body).not.toContain("console-fixture.ts");
  expect((await response!.body()).byteLength).toBeLessThan(32 * 1_024);
});

test("2,501 commitments remain bounded, paginated and filter-honest", async ({ page }) => {
  const started = performance.now();
  const response = await page.goto(`${url("large")}/?limit=100`);
  const elapsed = performance.now() - started;
  expect(response?.status()).toBe(200);
  expect((await response!.body()).byteLength).toBeLessThan(256 * 1_024);
  expect(elapsed).toBeLessThan(5_000);
  await expect(page.locator(".metric-strip div").filter({ hasText: "Active work" }).locator("dd")).toHaveText("2501");
  await expect(page.locator("[data-filter-row]")).toHaveCount(100);
  await expect(page.getByText("100 records loaded from a page of at most 100.")).toBeVisible();
  const firstIds = await page.locator(".data-table tbody tr code").allTextContents();
  await page.getByRole("link", { name: "Load next canonical page" }).click();
  await expect(page.locator("[data-filter-row]")).toHaveCount(50);
  const secondIds = await page.locator(".data-table tbody tr code").allTextContents();
  expect(secondIds.some((id) => firstIds.includes(id))).toBe(false);
  await page.getByLabel("Filter this loaded page").fill("large commitment 0101");
  await expect(page.locator("[data-filter-row]:visible")).toHaveCount(1);
  await expect(page.getByRole("status").filter({ hasText: "Showing 1 of 50" })).toBeVisible();
});
