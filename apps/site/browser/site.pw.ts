import { expect, test } from "@playwright/test";

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
  await expect(page.getByText("Server and cross-machine coordination are not shipped yet.", {
    exact: false,
  })).toBeVisible();
  await expect(page.getByRole("table")).toContainText("Tasq Local");
  await expect(page.getByRole("table")).toContainText("Not built");
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
  await expect(surfaces).toContainText("none");
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
});

test("mobile layout stays within the viewport and exposes navigation", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Docs" })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await page.getByRole("link", { name: "Docs" }).click();
  await expect(page.getByRole("navigation", { name: "Documentation", exact: true })).toBeVisible();
});
