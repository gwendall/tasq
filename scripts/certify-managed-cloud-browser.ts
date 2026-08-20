import { chromium, firefox, webkit, type BrowserType, type Route } from "playwright";
import { systemClock } from "@tasq-run/schema";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing required environment variable: ${name}`);
  return value;
}

function htmlAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

async function fetchWithoutRedirect(
  route: Route,
  headers: Record<string, string>,
): Promise<number> {
  const request = route.request();
  const method = request.method();
  const response = await fetch(request.url(), {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? undefined : request.postDataBuffer() ?? undefined,
    redirect: "manual",
  });
  const location = response.headers.get("location");
  if (response.status >= 300 && response.status < 400 && location) {
    const headers: Record<string, string> = {
      "cache-control": "no-store",
      "content-type": "text/html; charset=utf-8",
    };
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) headers["set-cookie"] = setCookie;
    await route.fulfill({
      status: 200,
      headers,
      body: `<!doctype html><meta http-equiv="refresh" content="0;url=${htmlAttribute(location)}">`,
    });
    return response.status;
  }
  await route.fulfill({
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body: Buffer.from(await response.arrayBuffer()),
  });
  return response.status;
}

async function main(): Promise<void> {
  const selectedEngine = process.env.TASQ_BROWSER_ENGINE;
  const engines: Array<[string, BrowserType]> = [
    ["chromium", chromium],
    ["firefox", firefox],
    ["webkit", webkit],
  ].filter(([name]) => selectedEngine === undefined || selectedEngine === name) as Array<[string, BrowserType]>;
  const results: Array<Record<string, unknown>> = [];

  for (const [name, engine] of engines) {
    process.stderr.write(`[${name}] launch\n`);
    const browser = await engine.launch({ headless: true });
    try {
      const identityAuthorization = `Basic ${Buffer.from(
        `${required("TASQ_ID_OPERATOR_USERNAME")}:${required("TASQ_ID_OPERATOR_PASSWORD")}`,
      ).toString("base64")}`;
      const context = await browser.newContext();
      await context.route("**/*", async (route) => {
        const requestUrl = new URL(route.request().url());
        if (requestUrl.origin === "https://control.tasq.run" && requestUrl.pathname === "/login") {
          const response = await fetch(route.request().url(), {
            headers: route.request().headers(),
            redirect: "manual",
          });
          const location = response.headers.get("location");
          const stateCookie = response.headers.get("set-cookie");
          if (response.status !== 303 || !location || !stateCookie ||
            new URL(location).origin !== "https://id.tasq.run") {
            throw new Error(`${name}: sign-in redirect absent`);
          }
          await route.fulfill({
            status: 200,
            headers: {
              "cache-control": "no-store",
              "content-type": "text/html; charset=utf-8",
              "set-cookie": stateCookie,
            },
            body: `<!doctype html><meta http-equiv="refresh" content="0;url=${htmlAttribute(location)}">`,
          });
          return;
        }
        if (requestUrl.origin !== "https://id.tasq.run") {
          await route.continue();
          return;
        }
        process.stderr.write(`[${name}] identity request ${requestUrl.pathname}\n`);
        const status = await fetchWithoutRedirect(route, {
          ...route.request().headers(),
          authorization: identityAuthorization,
        });
        process.stderr.write(`[${name}] identity response ${status}\n`);
      });
      const page = await context.newPage();
      page.on("request", (request) => {
        const requestUrl = new URL(request.url());
        if (requestUrl.origin === "https://id.tasq.run") {
          process.stderr.write(`[${name}] browser identity request ${requestUrl.pathname}\n`);
        }
      });
      page.on("response", (response) => {
        const responseUrl = new URL(response.url());
        if (responseUrl.origin === "https://id.tasq.run") {
          process.stderr.write(`[${name}] browser identity response ${response.status()}\n`);
        }
      });
      page.on("console", (message) => process.stderr.write(`[${name}] console ${message.type()}: ${message.text()}\n`));
      page.on("requestfailed", (request) => {
        const failedUrl = new URL(request.url());
        process.stderr.write(
          `[${name}] request failed ${failedUrl.origin}${failedUrl.pathname}: ${request.failure()?.errorText}\n`,
        );
      });
      page.setDefaultTimeout(15_000);
      page.setDefaultNavigationTimeout(20_000);
      const navigation: string[] = [];
      page.on("framenavigated", (frame) => {
        if (frame === page.mainFrame()) navigation.push(frame.url());
      });
      await page.goto("https://control.tasq.run/", { waitUntil: "networkidle" });
      process.stderr.write(`[${name}] unauthenticated console loaded\n`);
      const unauthenticated = await page.locator("body").innerText();
      if (!unauthenticated.includes("Sign in through")) throw new Error(`${name}: unauthenticated state absent`);
      const signInHref = await page.getByRole("link", { name: "Sign in", exact: true }).getAttribute("href");
      if (signInHref !== "/login") throw new Error(`${name}: sign-in route absent`);
      await page.getByRole("link", { name: "Sign in", exact: true }).click();
      await page.waitForURL("https://control.tasq.run/console", { waitUntil: "networkidle" });
      process.stderr.write(`[${name}] OIDC callback completed\n`);
      const authenticated = await page.locator("body").innerText();
      if (!authenticated.includes("Authenticated control-plane session active")) {
        throw new Error(`${name}: authenticated Console state absent`);
      }
      const cookies = await context.cookies("https://control.tasq.run/");
      const session = cookies.find((cookie) => cookie.name === "__Host-tasq_session");
      if (!session?.secure || !session.httpOnly || session.sameSite !== "Strict") {
        throw new Error(`${name}: hardened session cookie absent`);
      }
      const apiResponse = await page.evaluate(async () => {
        const response = await fetch("/api/tenants/tasq-beta/workspaces/main/version");
        return {
          ok: response.ok,
          status: response.status,
          body: await response.text(),
          rejection: response.headers.get("x-tasq-bff-rejection"),
        };
      });
      if (!apiResponse.ok) {
        throw new Error(`${name}: BFF read failed (${apiResponse.status}): ${apiResponse.body} [${apiResponse.rejection ?? "downstream"}]`);
      }
      process.stderr.write(`[${name}] BFF read completed\n`);
      const effectStatus = await page.evaluate(async () => {
        const response = await fetch("/api/tenants/tasq-beta/workspaces/main/effects/dispatch");
        return response.status;
      });
      if (effectStatus !== 403) throw new Error(`${name}: remote effect route was not denied`);
      process.stderr.write(`[${name}] remote effect denial completed\n`);
      await page.goto("https://control.tasq.run/console", { waitUntil: "networkidle" });
      await page.getByRole("link", { name: "Log out", exact: true }).click();
      await page.waitForURL("https://control.tasq.run/", { waitUntil: "networkidle" });
      const loggedOut = await page.locator("body").innerText();
      if (!loggedOut.includes("Sign in through")) throw new Error(`${name}: logout did not clear browser session`);
      process.stderr.write(`[${name}] logout completed\n`);
      results.push({
        engine: name,
        status: "passed",
        navigationOrigins: Array.from(new Set(navigation.map((url) => new URL(url).origin))),
        sessionCookie: { secure: true, httpOnly: true, sameSite: "Strict" },
        bffReadStatus: apiResponse.status,
        remoteEffectStatus: effectStatus,
        logout: "passed",
      });
    } finally {
      await browser.close();
    }
  }

  process.stdout.write(`${JSON.stringify({
    contractVersion: "tasq.managed-cloud-browser-evidence.v1",
    executedAt: new Date(systemClock.now()).toISOString(),
    publicOrigin: "https://control.tasq.run/",
    identityIssuer: "https://id.tasq.run/",
    status: "passed",
    results,
  }, null, 2)}\n`);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
