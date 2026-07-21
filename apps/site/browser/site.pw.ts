import { expect, test } from "@playwright/test";

test("homepage explains the product and the unpublished boundary", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("shared truth");
  await expect(page.getByRole("link", { name: "Build Tasq Local" })).toBeVisible();
  await expect(page.getByText("Repository access is private before launch")).toBeVisible();
  await expect(page.getByRole("table")).toContainText("Tasq Local");
  await expect(page.getByRole("table")).toContainText("Not built");
  await expect(page.locator("body")).not.toContainText("npm install @tasq/");
});

test("documentation gives a complete causal onboarding path", async ({ page }) => {
  await page.goto("/docs/getting-started/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("One ledger");
  await expect(page.getByText("canonical repository is private before launch", { exact: false })).toBeVisible();
  await expect(page.getByText("onboard", { exact: false }).first()).toBeVisible();
  await page.getByRole("link", { name: "For agents" }).click();
  await expect(page).toHaveURL(/\/docs\/agents\/?$/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("without sharing a runtime");
});

test("status page is traceable to machine contracts", async ({ page }) => {
  await page.goto("/status/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("pretend it shipped");
  await expect(page.getByText("PRODUCT_SURFACE_MATRIX.json")).toBeVisible();
  await expect(page.getByText("PUBLIC_RELEASE_POLICY.json")).toBeVisible();
  const surfaces = page.getByRole("table");
  await expect(surfaces).toContainText("Rest");
  await expect(surfaces).toContainText("none");
  const response = await page.request.get("/product-truth.json");
  expect(response.ok()).toBe(true);
  expect((await response.json()).contractVersion).toBe("tasq.public-site-truth.v1");
  const adoption = await page.request.get("/adopt.json");
  expect(adoption.ok()).toBe(true);
  expect(await adoption.json()).toMatchObject({
    contractVersion: "tasq.public-adoption.v1",
    distribution: {
      mode: "source_build",
      published: false,
      repositoryAccess: "authorized_private_prelaunch",
    },
  });
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
