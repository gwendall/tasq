import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { z } from "zod";

export const HOSTED_CONSOLE_CONTRACT_VERSION = "tasq.hosted-console.v1" as const;
const WorkspaceId = z.string().min(1).max(200).regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/);
const Cursor = z.string().min(1).max(2_000);
const SessionBody = z.object({ workspaceId: WorkspaceId }).strict();
const COOKIE = "__Host-tasq_session";

function response(body: string, status: number, contentType: string, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": contentType,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      // Chromium serializes a form POST Origin as `null` under `no-referrer`,
      // which would make the exact same-origin mutation guard reject the
      // Console's own forms. Keep referrers confined to this origin instead.
      "referrer-policy": "same-origin",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      ...headers,
    },
  });
}

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return response(JSON.stringify(body), status, "application/json", headers);
}

function cookieValue(request: Request): string | null {
  const raw = request.headers.get("cookie");
  if (!raw || raw.length > 8_192) return null;
  for (const part of raw.split(";")) {
    const [name, ...tail] = part.trim().split("=");
    if (name !== COOKIE) continue;
    try {
      const authorization = Buffer.from(tail.join("="), "base64url").toString("utf8");
      return /^Bearer [^\u0000-\u001f\u007f]{32,3500}$/.test(authorization) ? authorization : null;
    } catch {
      return null;
    }
  }
  return null;
}

async function boundedText(request: Request): Promise<string> {
  const maximum = 4_096;
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^(0|[1-9][0-9]*)$/.test(declared) || Number(declared) > maximum)) {
    throw new Error("body too large");
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maximum) throw new Error("body too large");
  return text;
}

async function boundedJson(request: Request): Promise<unknown> {
  return JSON.parse(await boundedText(request));
}

async function boundedJsonForm(request: Request): Promise<string> {
  return boundedText(request);
}

function escape(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function loginPage(error = ""): string {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Tasq Server</title><style>${style()}</style><main><p class="eyebrow">TASQ SERVER</p>
<h1>Connect this browser</h1><p>The hosted Console exposes a small guarded human action surface. Paste a scoped access token; it is exchanged
server-side for a Secure, HttpOnly, same-origin browser cookie and never enters the URL.</p>
<form method="post" action="/session/connect"><p><label>Workspace<br><input name="workspaceId" required autocomplete="off"></label></p>
<p><label>Access token<br><input name="accessToken" type="password" required autocomplete="off"></label></p>
<button>Open Console</button></form>
${error ? `<p class="error">${escape(error)}</p>` : ""}</main></html>`;
}

function style(): string {
  return `:root{color-scheme:light;background:#f5f2e8;color:#171813;font:16px/1.5 system-ui,sans-serif}
body{margin:0}main{max-width:70rem;margin:auto;padding:4rem 2rem}h1{font-size:clamp(2.5rem,8vw,6rem);line-height:.95}
.eyebrow{font:700 .75rem/1.2 ui-monospace,monospace;letter-spacing:.14em;color:#59604d}
code,.meta{font-family:ui-monospace,monospace}.grid{display:grid;gap:1rem}.card{border:1px solid #a5a79d;padding:1.25rem;background:#fffdf5}
.status{display:inline-block;padding:.15rem .45rem;background:#d7ff38;color:#171813}.error{color:#9b1c1c}
form{display:grid;gap:.65rem;margin-block:1rem}label{display:grid;gap:.25rem}input,button{font:inherit;padding:.6rem;border:1px solid #777;background:#fff}button{width:max-content;cursor:pointer}
a{color:inherit}nav{display:flex;justify-content:space-between;gap:1rem;margin-bottom:4rem}`;
}

function consolePage(workspaceId: string, payload: Record<string, unknown>, nextCursor: string | null): string {
  const raw = Array.isArray(payload["items"]) ? payload["items"] : [];
  const cards = raw.map((item) => {
    const value = typeof item === "object" && item !== null ? item as Record<string, unknown> : {};
    const id = escape(value["id"]);
    const revision = escape(value["revision"]);
    const action = `/console/action?workspace=${encodeURIComponent(workspaceId)}`;
    return `<article class="card"><p class="eyebrow">${id}</p><h2>${escape(value["title"])}</h2>
<p><span class="status">${escape(value["status"])}</span> · revision ${revision}</p>
<details><summary>Human actions</summary>
<form method="post" action="${action}"><input type="hidden" name="action" value="claim"><input type="hidden" name="commitmentId" value="${id}"><input type="hidden" name="idempotencyKey" value="${randomUUID()}"><button>Claim</button></form>
<form method="post" action="${action}"><input type="hidden" name="action" value="block"><input type="hidden" name="commitmentId" value="${id}"><input type="hidden" name="expectedRevision" value="${revision}"><input type="hidden" name="idempotencyKey" value="${randomUUID()}"><label>Block reason <input name="reason" required maxlength="2000"></label><button>Block</button></form>
<form method="post" action="${action}"><input type="hidden" name="action" value="evidence"><input type="hidden" name="commitmentId" value="${id}"><input type="hidden" name="idempotencyKey" value="${randomUUID()}"><label>Evidence kind <input name="kind" required maxlength="200"></label><label>Summary <input name="summary" maxlength="2000"></label><button>Add evidence</button></form>
<form method="post" action="${action}"><input type="hidden" name="action" value="trust"><input type="hidden" name="commitmentId" value="${id}"><input type="hidden" name="idempotencyKey" value="${randomUUID()}"><label>Evidence ID <input name="evidenceId" required></label><label>Attribution reason <input name="reason" value="Recorded by authenticated Console operator; authenticity not independently verified" required maxlength="2000"></label><button>Record unverified trust</button></form>
<form method="post" action="${action}"><input type="hidden" name="action" value="proposal"><input type="hidden" name="commitmentId" value="${id}"><input type="hidden" name="idempotencyKey" value="${randomUUID()}"><label>Resolution contract ID <input name="contractId" required></label><label>Criterion ID <input name="criterionId" required></label><label>Evidence ID <input name="evidenceId" required></label><label>Summary <input name="summary" maxlength="2000"></label><button>Propose completion</button></form>
<form method="post" action="${action}"><input type="hidden" name="action" value="approve"><input type="hidden" name="commitmentId" value="${id}"><input type="hidden" name="idempotencyKey" value="${randomUUID()}"><input type="hidden" name="outcome" value="accepted"><label>Proposal ID <input name="proposalId" required></label><label>Reason code <input name="reasonCode" value="human_approved" required maxlength="120"></label><label>Explanation <input name="explanation" required maxlength="2000"></label><button>Approve proposal</button></form>
</details></article>`;
  }).join("");
  const more = nextCursor
    ? `<p><a href="/console?workspace=${encodeURIComponent(workspaceId)}&cursor=${encodeURIComponent(nextCursor)}">Next page →</a></p>`
    : "";
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Tasq · ${escape(workspaceId)}</title><style>${style()}</style><main><nav><strong>tasq</strong>
<form method="post" action="/v1/session/logout"><button>Log out</button></form></nav>
<p class="eyebrow">AUTHENTICATED · GUARDED HUMAN ACTIONS</p><h1>${escape(workspaceId)}</h1>
<form class="card" method="post" action="/console/action?workspace=${encodeURIComponent(workspaceId)}"><h2>Create commitment</h2>
<input type="hidden" name="action" value="create"><input type="hidden" name="idempotencyKey" value="${randomUUID()}">
<label>Title <input name="title" required maxlength="500"></label><button>Create</button></form>
<section class="grid">${cards || '<p class="card">No commitments yet.</p>'}</section>${more}</main></html>`;
}

function requiredForm(form: URLSearchParams, key: string, maximum = 500): string {
  const value = form.get(key);
  if (!value || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`invalid ${key}`);
  }
  return value;
}

function actionRequest(form: URLSearchParams, workspaceId: string): {
  operationId: string;
  resource: { kind: "workspace" | "commitment"; id: string };
  expectedRevision: number | null;
  input: unknown;
  idempotencyKey: string;
} {
  const action = requiredForm(form, "action", 20);
  const idempotencyKey = requiredForm(form, "idempotencyKey");
  if (action === "create") {
    return {
      operationId: "commitment.propose",
      resource: { kind: "workspace", id: workspaceId },
      expectedRevision: null,
      input: { title: requiredForm(form, "title", 500) },
      idempotencyKey,
    };
  }
  const commitmentId = requiredForm(form, "commitmentId");
  if (action === "claim") {
    return {
      operationId: "claim.acquire",
      resource: { kind: "commitment", id: commitmentId },
      expectedRevision: null,
      input: {},
      idempotencyKey,
    };
  }
  if (action === "block") {
    const expectedRevision = Number(requiredForm(form, "expectedRevision", 20));
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new Error("invalid expectedRevision");
    return {
      operationId: "commitment.transition",
      resource: { kind: "commitment", id: commitmentId },
      expectedRevision,
      input: { transition: "block", reason: requiredForm(form, "reason", 2_000) },
      idempotencyKey,
    };
  }
  if (action === "evidence") {
    return {
      operationId: "evidence.add",
      resource: { kind: "commitment", id: commitmentId },
      expectedRevision: null,
      input: {
        kind: requiredForm(form, "kind", 200),
        summary: form.get("summary") || null,
        source: "hosted-console:human",
      },
      idempotencyKey,
    };
  }
  if (action === "trust") {
    return {
      operationId: "resolution.trust.attest-unverified",
      resource: { kind: "commitment", id: commitmentId },
      expectedRevision: null,
      input: {
        evidenceId: requiredForm(form, "evidenceId"),
        reason: requiredForm(form, "reason", 2_000),
      },
      idempotencyKey,
    };
  }
  if (action === "proposal") {
    return {
      operationId: "resolution.proposal.create",
      resource: { kind: "commitment", id: commitmentId },
      expectedRevision: null,
      input: {
        resolutionContractId: requiredForm(form, "contractId"),
        criterionEvidence: [{
          criterionId: requiredForm(form, "criterionId", 120),
          evidenceIds: [requiredForm(form, "evidenceId")],
        }],
        summary: form.get("summary") || null,
      },
      idempotencyKey,
    };
  }
  if (action === "approve") {
    return {
      operationId: "resolution.decision.attest",
      resource: { kind: "commitment", id: commitmentId },
      expectedRevision: null,
      input: {
        proposalId: requiredForm(form, "proposalId"),
        outcome: "accepted",
        reasonCode: requiredForm(form, "reasonCode", 120),
        explanation: requiredForm(form, "explanation", 2_000),
      },
      idempotencyKey,
    };
  }
  throw new Error("unknown action");
}

export function createHostedConsoleHandler(input: {
  publicUrl: string;
  restHandler: (request: Request) => Promise<Response>;
}): (request: Request) => Promise<Response | null> {
  const publicUrl = new URL(input.publicUrl);
  async function probe(workspaceId: string, authorization: string): Promise<Response> {
    return input.restHandler(new Request(new URL(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/commitments?limit=1`,
      publicUrl,
    ), { headers: { authorization, "x-tasq-request-id": "console-session-probe" } }));
  }
  const sessionCookie = (authorization: string) =>
    `${COOKIE}=${Buffer.from(authorization, "utf8").toString("base64url")}; Path=/; Secure; HttpOnly; SameSite=Strict`;
  return async (request) => {
    const url = new URL(request.url);
    if (url.pathname === "/v1/session" && request.method === "POST") {
      const authorization = request.headers.get("authorization");
      if (!authorization || authorization.length > 3_507 || !/^Bearer /.test(authorization)) {
        return json({ contractVersion: HOSTED_CONSOLE_CONTRACT_VERSION, code: "authentication_required" }, 401);
      }
      let body: z.infer<typeof SessionBody>;
      try {
        body = SessionBody.parse(await boundedJson(request));
      } catch {
        return json({ contractVersion: HOSTED_CONSOLE_CONTRACT_VERSION, code: "invalid_session_request" }, 400);
      }
      const checked = await probe(body.workspaceId, authorization);
      if (!checked.ok) {
        return json({ contractVersion: HOSTED_CONSOLE_CONTRACT_VERSION, code: "access_denied" }, checked.status);
      }
      return json({
        contractVersion: HOSTED_CONSOLE_CONTRACT_VERSION,
        workspaceId: body.workspaceId,
        location: `/console?workspace=${encodeURIComponent(body.workspaceId)}`,
      }, 201, {
        "set-cookie": sessionCookie(authorization),
      });
    }
    if (url.pathname === "/session/connect" && request.method === "POST") {
      let form: URLSearchParams;
      try {
        if (request.headers.get("content-type")?.split(";", 1)[0] !== "application/x-www-form-urlencoded") {
          throw new Error("invalid content type");
        }
        form = new URLSearchParams(String(await boundedJsonForm(request)));
      } catch {
        return response(loginPage("Invalid session request."), 400, "text/html; charset=utf-8");
      }
      const workspace = WorkspaceId.safeParse(form.get("workspaceId"));
      const accessToken = form.get("accessToken");
      if (!workspace.success || !accessToken || accessToken.length > 3_500
        || /[\u0000-\u001f\u007f]/.test(accessToken)) {
        return response(loginPage("Invalid workspace or token."), 400, "text/html; charset=utf-8");
      }
      const authorization = accessToken.startsWith("Bearer ") ? accessToken : `Bearer ${accessToken}`;
      const checked = await probe(workspace.data, authorization);
      if (!checked.ok) return response(loginPage("Token or workspace access denied."), 401, "text/html; charset=utf-8");
      return new Response(null, {
        status: 303,
        headers: {
          location: `/console?workspace=${encodeURIComponent(workspace.data)}`,
          "cache-control": "no-store",
          "set-cookie": sessionCookie(authorization),
        },
      });
    }
    if (url.pathname === "/v1/session/logout" && request.method === "POST") {
      return new Response(null, {
        status: 303,
        headers: {
          location: "/console",
          "cache-control": "no-store",
          "set-cookie": `${COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`,
        },
      });
    }
    if (url.pathname === "/console/action" && request.method === "POST") {
      const workspace = WorkspaceId.safeParse(url.searchParams.get("workspace"));
      const authorization = cookieValue(request);
      if (!workspace.success || !authorization || url.searchParams.size !== 1
        || request.headers.get("origin") !== publicUrl.origin
        || request.headers.get("content-type")?.split(";", 1)[0] !== "application/x-www-form-urlencoded") {
        return response(loginPage("Invalid or expired action session."), 400, "text/html; charset=utf-8");
      }
      let selected: ReturnType<typeof actionRequest>;
      try {
        selected = actionRequest(new URLSearchParams(await boundedJsonForm(request)), workspace.data);
      } catch {
        return response(loginPage("Invalid action input."), 400, "text/html; charset=utf-8");
      }
      const upstream = await input.restHandler(new Request(new URL(
        `/v1/workspaces/${encodeURIComponent(workspace.data)}/operations/${selected.operationId}`,
        publicUrl,
      ), {
        method: "POST",
        headers: {
          authorization,
          "content-type": "application/json",
          "idempotency-key": selected.idempotencyKey,
          "x-tasq-request-id": `console-action-${selected.idempotencyKey}`,
        },
        body: JSON.stringify({
          contractVersion: "tasq.hosted-mutation-request.v1",
          resource: selected.resource,
          expectedRevision: selected.expectedRevision,
          input: selected.input,
        }),
      }));
      if (!upstream.ok) {
        const problem = await upstream.json().catch(() => ({ code: "operation_failed" })) as { code?: string };
        return response(loginPage(`Action failed: ${problem.code ?? "operation_failed"}.`), upstream.status, "text/html; charset=utf-8");
      }
      return new Response(null, {
        status: 303,
        headers: {
          location: `/console?workspace=${encodeURIComponent(workspace.data)}`,
          "cache-control": "no-store",
        },
      });
    }
    if (url.pathname !== "/console" || request.method !== "GET") return null;
    const workspace = WorkspaceId.safeParse(url.searchParams.get("workspace"));
    const cursor = url.searchParams.get("cursor");
    if (url.searchParams.size > (cursor === null ? 1 : 2)
      || (cursor !== null && !Cursor.safeParse(cursor).success)) {
      return response(loginPage("Invalid Console URL."), 400, "text/html; charset=utf-8");
    }
    const authorization = cookieValue(request);
    if (!authorization || !workspace.success) return response(loginPage(), 401, "text/html; charset=utf-8");
    const params = new URLSearchParams({ limit: "50", ...(cursor ? { cursor } : {}) });
    const upstream = await input.restHandler(new Request(new URL(
      `/v1/workspaces/${encodeURIComponent(workspace.data)}/commitments?${params}`,
      publicUrl,
    ), { headers: { authorization, "x-tasq-request-id": "console-page" } }));
    if (!upstream.ok) {
      const code = upstream.status === 401 ? "Session expired. Connect this browser again." : "Workspace access denied.";
      return response(loginPage(code), upstream.status, "text/html; charset=utf-8");
    }
    const payload = await upstream.json() as Record<string, unknown>;
    return response(
      consolePage(workspace.data, payload, typeof payload["nextCursor"] === "string" ? payload["nextCursor"] : null),
      200,
      "text/html; charset=utf-8",
    );
  };
}
