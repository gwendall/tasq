import { expect, request as apiRequest, test } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";

interface BrowserInput {
  contractVersion: "tasq.tq811-browser-input.v1";
  publicUrl: string;
  workspaceId: string;
  accessToken: string;
  resultPath: string;
}

function inputPath(): string {
  const value = process.env.TASQ_TQ811_BROWSER_INPUT;
  if (!value) throw new Error("TASQ_TQ811_BROWSER_INPUT is required");
  return value;
}

test("TQ-811 authenticates a real browser and preserves the guard through a hosted Console mutation", async ({
  page,
}) => {
  const input = JSON.parse(await readFile(inputPath(), "utf8")) as BrowserInput;
  expect(input.contractVersion).toBe("tasq.tq811-browser-input.v1");
  expect(input.publicUrl).toMatch(/^https:\/\/localhost:\d+\/$/);
  expect(input.workspaceId).toBe("certification/browser");
  if (!/^tasq_access_[^\u0000-\u001f\u007f]{20,3500}$/.test(input.accessToken)) {
    throw new Error("browser input contains no valid opaque access credential");
  }

  const login = await page.goto(new URL("/console", input.publicUrl).href);
  expect(login?.status()).toBe(401);
  await expect(page.getByRole("heading", { name: "Connect this browser" })).toBeVisible();
  await page.getByLabel("Workspace").fill(input.workspaceId);
  await page.getByLabel("Access token").fill(input.accessToken);
  await Promise.all([
    page.waitForURL(new RegExp(`/console\\?workspace=${encodeURIComponent(input.workspaceId)}$`)),
    page.getByRole("button", { name: "Open Console" }).click(),
  ]);
  expect(page.url().includes(input.accessToken)).toBe(false);
  const cookies = await page.context().cookies(input.publicUrl);
  const session = cookies.find(({ name }) => name === "__Host-tasq_session");
  expect(session).toMatchObject({
    httpOnly: true,
    secure: true,
    sameSite: "Strict",
    path: "/",
  });

  const encodedWorkspace = encodeURIComponent(input.workspaceId);
  const operationUrl = new URL(
    `/v1/workspaces/${encodedWorkspace}/operations/commitment.propose`,
    input.publicUrl,
  ).href;
  const api = await apiRequest.newContext({ ignoreHTTPSErrors: true });
  const unauthenticated = await api.post(operationUrl, {
    data: {
      contractVersion: "tasq.hosted-mutation-request.v1",
      resource: { kind: "workspace", id: input.workspaceId },
      expectedRevision: null,
      input: { title: "Must never cross the guard" },
    },
    headers: {
      "idempotency-key": "tq811-unauthenticated",
      "x-tasq-request-id": "tq811-unauthenticated",
    },
  });
  expect(unauthenticated.status()).toBe(401);
  expect(await unauthenticated.json()).toMatchObject({ code: "authentication_required" });

  const createForm = page.locator('form[action^="/console/action"]').filter({
    has: page.getByRole("button", { name: "Create" }),
  });
  const idempotencyKey = await createForm.locator('input[name="idempotencyKey"]').inputValue();
  const title = "Created through certified hosted Console";
  await createForm.getByLabel("Title").fill(title);
  const [actionResponse] = await Promise.all([
    page.waitForResponse((response) =>
      response.url().includes("/console/action?") && response.request().method() === "POST"),
    createForm.getByRole("button", { name: "Create" }).click(),
  ]);
  const actionHeaders = await actionResponse.request().allHeaders();
  expect(actionHeaders.origin).toBe(new URL(input.publicUrl).origin);
  expect(actionHeaders["content-type"]).toContain("application/x-www-form-urlencoded");
  expect(Boolean(actionHeaders.cookie?.startsWith("__Host-tasq_session="))).toBe(true);
  expect(new URL(actionResponse.url()).searchParams.get("workspace")).toBe(input.workspaceId);
  expect(actionResponse.status()).toBe(303);
  await expect(page.getByRole("heading", { name: title })).toBeVisible();

  let replay;
  try {
    replay = await api.post(operationUrl, {
      data: {
        contractVersion: "tasq.hosted-mutation-request.v1",
        resource: { kind: "workspace", id: input.workspaceId },
        expectedRevision: null,
        input: { title },
      },
      headers: {
        authorization: `Bearer ${input.accessToken}`,
        "idempotency-key": idempotencyKey,
        "x-tasq-request-id": `console-action-${idempotencyKey}`,
      },
    });
  } catch {
    throw new Error("guarded receipt replay request failed");
  }
  expect(replay.status()).toBe(200);
  const replayBody = await replay.json();
  expect(replayBody).toMatchObject({
    contractVersion: "tasq.hosted-mutation-response.v1",
    outcome: {
      operationId: "commitment.propose",
      resultType: "commitment",
      replayed: true,
      result: { title },
    },
  });
  expect(replayBody.outcome.requestDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(replayBody.outcome.idempotencyKeyDigest).toMatch(/^sha256:[a-f0-9]{64}$/);

  const attacker = await page.context().newPage();
  const actionUrl = new URL(`/console/action?workspace=${encodedWorkspace}`, input.publicUrl).href;
  await attacker.setContent(`<form method="post" action="${actionUrl}">
    <input name="action" value="create">
    <input name="idempotencyKey" value="tq811-off-origin">
    <input name="title" value="Must never cross the origin guard">
    <button>Cross-origin submit</button>
  </form>`);
  const [offOrigin] = await Promise.all([
    attacker.waitForResponse((response) =>
      response.url().includes("/console/action?") && response.request().method() === "POST"),
    attacker.getByRole("button", { name: "Cross-origin submit" }).click(),
  ]);
  expect(offOrigin.status()).toBe(400);
  await attacker.close();

  let listed;
  try {
    listed = await api.get(
      new URL(`/v1/workspaces/${encodedWorkspace}/commitments?limit=10`, input.publicUrl).href,
      {
        headers: {
          authorization: `Bearer ${input.accessToken}`,
          "x-tasq-request-id": "tq811-list-after-browser",
        },
      },
    );
  } catch {
    throw new Error("guarded commitment verification request failed");
  }
  expect(listed.status()).toBe(200);
  const listBody = await listed.json();
  expect(listBody.items.filter((item: { title: string }) => item.title === title)).toHaveLength(1);
  expect(listBody.items.some((item: { title: string }) => item.title.includes("Must never"))).toBe(false);
  await api.dispose();

  await writeFile(input.resultPath, `${JSON.stringify({
    contractVersion: "tasq.tq811-browser-result.v1",
    browser: "chromium",
    sessionCookie: "Secure_HttpOnly_SameSite_Strict_Host_prefix",
    consoleMutation: "commitment.propose",
    receiptReplay: true,
    resultId: replayBody.outcome.resultId,
    requestDigest: replayBody.outcome.requestDigest,
    idempotencyKeyDigest: replayBody.outcome.idempotencyKeyDigest,
    outsideGuard: {
      missingCredential: "rejected_401",
      foreignOrigin: "rejected_400",
      unauthorizedStateCommitted: false,
    },
  })}\n`, { encoding: "utf8", mode: 0o600 });
});
