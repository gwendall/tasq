import { expect, test } from "@playwright/test";

test("homepage explains the product and its generated release boundary", async ({ page }) => {
  await page.goto("/");
  const truth = await (await page.request.get("/product-truth.json")).json();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("shared truth");
  await expect(page.getByRole("link", {
    name: truth.release.published ? "Install Tasq Local" : "Build Tasq Local",
  })).toBeVisible();
  await expect(page.getByText(
    truth.release.published
      ? `Public alpha ${truth.release.version}. Packages and checksummed releases are live.`
      : "Public source alpha. Bootstrap package identities exist; the supported release is pending.",
    { exact: true },
  )).toBeVisible();
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
