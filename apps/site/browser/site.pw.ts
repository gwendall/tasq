import { expect, test } from "@playwright/test";

import comparison from "../../../docs/contracts/TQ-621_MULTI_AGENT_COMPARISON.json" with { type: "json" };

// Read the version the page itself renders, not one release's number. A
// literal here failed the moment a release shipped, which is the same trap
// several policy blocks and evals fell into: encoding a release instead of
// the rule that outlives it.
const publishedVersion = comparison.tasqClaimBoundary.version;

test("homepage explains the product and its generated release boundary", async ({ page }) => {
  await page.goto("/");
  const truth = await (await page.request.get("/product-truth.json")).json();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("duplicate work");
  await expect(page.getByRole("link", {
    name: truth.release.published ? "Install Tasq" : "Build Tasq",
  })).toBeVisible();
  await expect(page.getByText(
    truth.release.published
      ? `Tasq Local ${truth.release.version} is available now.`
      : "Tasq Local builds from source today.",
    { exact: false },
  )).toBeVisible();
  await expect(page.getByRole("img", {
    name: "The real Tasq Local Console showing a mature coordination workspace",
  })).toBeVisible();
  await expect(page.getByText("A separately published Server image supports authenticated remote coordination; managed Cloud is not available.", {
    exact: false,
  })).toBeVisible();
  await expect(page.getByText(`Local ${truth.release.version} and the authenticated self-hosted Server are published alphas.`, {
    exact: false,
  })).toBeVisible();
  const demo = page.getByRole("img", {
    name: "Tasq public CLI demo creating and completing one isolated task",
  });
  const productTable = page.getByRole("table");
  await expect(demo).toBeVisible();
  await demo.scrollIntoViewIfNeeded();
  await demo.evaluate((image: HTMLImageElement) => image.decode());
  await expect.poll(() => demo.evaluate((image: HTMLImageElement) => ({
    complete: image.complete,
    naturalHeight: image.naturalHeight,
    naturalWidth: image.naturalWidth,
  }))).toEqual({ complete: true, naturalHeight: 360, naturalWidth: 640 });
  expect(await demo.evaluate((image) => Boolean(
    image.compareDocumentPosition(document.querySelector(".product-table")!)
      & Node.DOCUMENT_POSITION_FOLLOWING
  ))).toBe(true);
  await expect(productTable).toContainText("Tasq Local");
  await expect(productTable).toContainText("Tasq Server");
  await expect(productTable).toContainText("Candidate");
  if (!truth.release.published) await expect(page.locator("body")).not.toContainText("npm install @tasq-run/");
});

test("documentation gives a complete causal onboarding path", async ({ page }) => {
  await page.goto("/docs/getting-started/");
  const truth = await (await page.request.get("/product-truth.json")).json();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("One ledger");
  await expect(page.getByRole("heading", {
    level: 2,
    name: truth.release.published ? "Install the public alpha" : "Current installation path",
  })).toBeVisible();
  await expect(page.getByText("onboard", { exact: false }).first()).toBeVisible();
  await page.getByRole("link", { name: "For agents" }).click();
  await expect(page).toHaveURL(/\/docs\/agents\/?$/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("without sharing a runtime");
});

test("documentation distinguishes self-hosted Server from managed Cloud", async ({ page }) => {
  await page.goto("/docs/support/");
  await expect(page.getByText("ghcr.io/gwendall/tasq-server:0.4.0", { exact: false })).toBeVisible();
  await expect(page.getByText("Managed Cloud remains unavailable", { exact: false })).toBeVisible();

  await page.goto("/docs/mcp/");
  await expect(page.getByText("authenticated Streamable HTTP remote MCP", { exact: false })).toBeVisible();
});

test("an unknown agent can discover host recipes and stable machine entrypoints", async ({ page }) => {
  await page.goto("/agents/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("same work");
  await expect(page.getByText("codex mcp add tasq", { exact: false })).toBeVisible();
  await expect(page.getByText("claude mcp add tasq", { exact: false })).toBeVisible();
  await expect(page.getByText("A project file is a pointer, never permission.")).toBeVisible();

  const [skill, integration, llms, rendezvous] = await Promise.all([
    page.request.get("/SKILL.md"),
    page.request.get("/integration.json"),
    page.request.get("/llms.txt"),
    page.request.get("/schemas/project-rendezvous.v1.schema.json"),
  ]);
  expect(skill.ok()).toBe(true);
  expect(await skill.text()).toContain("Never infer a space");
  expect(integration.ok()).toBe(true);
  expect((await integration.json()).contractVersion).toBe("tasq.agent-integrations.v1");
  expect(llms.ok()).toBe(true);
  expect(await llms.text()).toContain("Current boundary:");
  expect(rendezvous.ok()).toBe(true);
  expect((await rendezvous.json()).additionalProperties).toBe(false);
});

test("status page is traceable to machine contracts", async ({ page }) => {
  await page.goto("/status/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("pretend it shipped");
  await expect(page.getByText("docs/concepts/PRODUCT_SURFACE_MATRIX.json")).toBeVisible();
  await expect(page.getByText("docs/releases/PUBLIC_RELEASE_POLICY.json")).toBeVisible();
  const surfaces = page.getByRole("table");
  await expect(surfaces).toContainText("Rest");
  await expect(surfaces).toContainText("Cloud Bff");
  await expect(surfaces).toContainText("Candidate");
  await expect(page.getByText("8 public packages", { exact: true })).toBeVisible();
  await expect(page.getByText("Managed Cloud remains experimental and unavailable", { exact: false })).toBeVisible();
  const response = await page.request.get("/product-truth.json");
  expect(response.ok()).toBe(true);
  expect((await response.json()).contractVersion).toBe("tasq.public-site-truth.v1");
  const adoption = await page.request.get("/adopt.json");
  expect(adoption.ok()).toBe(true);
  const adoptionContract = await adoption.json();
  expect(adoptionContract.contractVersion).toBe("tasq.public-adoption.v1");
  expect(adoptionContract.distribution.mode).toBe(
    adoptionContract.distribution.published ? "npm_and_github_release" : "source_build",
  );

  await page.goto("/docs/cli/");
  await expect(page.getByRole("heading", { level: 2, name: "REMOTE SERVER" })).toBeVisible();
  await expect(page.locator("body")).not.toContainText("product not shipped");
});

test("comparison page separates execution, orchestration and durable coordination", async ({ page }) => {
  await page.goto("/compare/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Parallel is not the same as coordinated");
  await expect(page.getByText(`Tasq ${publishedVersion}`, { exact: false })).toBeVisible();
  await expect(page.getByText("separately operated Server", { exact: false }).first()).toBeVisible();
  await expect(page.getByText("Managed Cloud is unavailable", { exact: false }).first()).toBeVisible();
  const matrix = page.getByRole("table");
  await expect(matrix).toContainText("Claude Code agent teams");
  await expect(matrix).toContainText("OpenAI Codex app");
  await expect(matrix).toContainText("MCP Tasks and A2A Tasks");
  await expect(page.getByText("Tasq is the coordination record, not the agent runner.")).toBeVisible();
  await expect(page.getByRole("link", { name: /Anthropic: Orchestrate teams/ })).toHaveAttribute("href", "https://code.claude.com/docs/en/agent-teams");
  await expect(page.getByRole("link", { name: /Machine-readable matrix/ })).toHaveAttribute("href", /TQ-621_MULTI_AGENT_COMPARISON\.json$/);
  await expect(page.locator("body")).not.toContainText("Server is not shipped");
});

test("mobile layout stays within the viewport and exposes navigation", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Docs" })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await page.getByRole("link", { name: "Docs" }).click();
  await expect(page.getByRole("navigation", { name: "Documentation", exact: true })).toBeVisible();

  await page.goto("/compare/");
  await expect(page.getByRole("link", { name: "Compare", exact: true })).toBeVisible();
  const compareOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(compareOverflow).toBeLessThanOrEqual(1);
});

test("the OpenGraph card is served as an image, not as opaque bytes", async ({ page }) => {
  // A valid PNG served as application/octet-stream still returns 200 and still
  // passes every local check, while link unfurlers quietly refuse to render it.
  await page.goto("/");
  const declared = await page.locator('meta[property="og:image"]').getAttribute("content");
  expect(declared).toBeTruthy();

  // The tag carries the absolute production URL via metadataBase; request the
  // same path from the export under test rather than from the live site.
  const { pathname, search } = new URL(declared!);
  const image = await page.request.get(`${pathname}${search}`);
  expect(image.ok()).toBe(true);
  expect(image.headers()["content-type"]).toContain("image/png");

  const body = await image.body();
  expect(body.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
});
