import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMutableClock } from "@tasq/schema";
import {
  createCommitment,
  inspectCommitment,
  listEvents,
  openDb,
  runKernelMigrations,
  type CommitmentInspection,
} from "@tasq/core";
import {
  assertLoopbackHost,
  createTasqInspectorHandler,
  renderCommitmentPage,
  startTasqInspectorServer,
} from "../src/index.js";

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

async function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "tasq-inspector-"));
  tmpDirs.push(dir);
  const handle = await openDb({ url: `file:${join(dir, "db.sqlite")}`, wal: false });
  const clock = createMutableClock(50_000);
  await runKernelMigrations(handle.client, { clock, installReferenceExtension: false });
  const workspaceId = "inspection/team-a";
  const commitment = await createCommitment(handle.db, {
    title: `<script>alert("title")</script>`,
    description: `<img src=x onerror="description">`,
  }, { workspaceId, actor: `<svg onload="actor">`, clock });
  await createCommitment(handle.db, { title: "Foreign workspace secret" }, {
    workspaceId: "inspection/team-b",
    actor: "fixture",
    clock,
  });
  return { ...handle, clock, workspaceId, commitment };
}

function expectSecurityHeaders(response: Response): void {
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
  expect(response.headers.get("content-security-policy")).not.toContain("script-src");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
}

describe("Tasq read-only inspector handler", () => {
  it("serves bounded HTML and canonical JSON with one injected snapshot clock", async () => {
    const h = await fresh();
    try {
      const handler = createTasqInspectorHandler(h);
      h.clock.set(61_000);
      const page = await handler(new Request("http://127.0.0.1/"));
      expect(page.status).toBe(200);
      expectSecurityHeaders(page);
      expect(page.headers.get("date")).toBe("Thu, 01 Jan 1970 00:01:01 GMT");
      const html = await page.text();
      expect(html).toContain("&lt;script&gt;alert(&quot;title&quot;)&lt;/script&gt;");
      expect(html).not.toContain("<script>alert");
      expect(html).not.toContain("Foreign workspace secret");
      expect(html).not.toContain("<script src=");
      expect(html).not.toContain("<form method=\"post\"");

      const index = await handler(new Request("http://localhost/api/index?limit=10"));
      expect(index.status).toBe(200);
      const indexJson = await index.json() as Record<string, unknown>;
      expect(indexJson).toMatchObject({
        contractVersion: "tasq.inspector-index.v1",
        inspectedAt: 61_000,
        workspaceId: h.workspaceId,
      });

      h.clock.set(62_000);
      const detail = await handler(new Request(`http://[::1]/api/commitments/${h.commitment.id}`));
      expect(detail.status).toBe(200);
      expect(await detail.json()).toMatchObject({
        contractVersion: "tasq.inspect.v1",
        inspectedAt: 62_000,
        workspaceId: h.workspaceId,
        commitment: { id: h.commitment.id },
      });
    } finally {
      await h.close();
    }
  });

  it("exposes only bounded redacted Console read routes under the same loopback boundary", async () => {
    const h = await fresh();
    try {
      const handler = createTasqInspectorHandler(h);
      h.clock.set(63_000);
      const overview = await handler(new Request("http://localhost/api/console/overview"));
      expect(overview.status).toBe(200);
      expectSecurityHeaders(overview);
      expect(await overview.json()).toMatchObject({
        contractVersion: "tasq.console-overview.v1",
        workspaceId: h.workspaceId,
        inspectedAt: 63_000,
      });

      const work = await handler(new Request("http://127.0.0.1/api/console/work?limit=1"));
      expect(work.status).toBe(200);
      const workBody = await work.json() as Record<string, unknown>;
      expect(workBody).toMatchObject({
        contractVersion: "tasq.console-page.v1",
        section: "work",
        requestedLimit: 1,
        returned: 1,
      });
      expect(JSON.stringify(workBody)).not.toContain("Foreign workspace secret");

      const audit = await handler(new Request("http://[::1]/api/console/audit?limit=100"));
      expect(audit.status).toBe(200);
      const auditBody = await audit.json() as { items: Array<Record<string, unknown>> };
      expect(auditBody.items.every((item) => JSON.stringify(item.payload) ===
        JSON.stringify({ omitted: true, reason: "operator_index_redaction" }))).toBe(true);

      const health = await handler(new Request("http://localhost/api/console/health", { method: "HEAD" }));
      expect(health.status).toBe(200);
      expect(health.headers.get("date")).toBe("Thu, 01 Jan 1970 00:01:03 GMT");
      expect(await health.text()).toBe("");

      const invalidSection = await handler(new Request("http://localhost/api/console/secrets"));
      expect(invalidSection.status).toBe(400);
      expect(await invalidSection.json()).toMatchObject({ error: { code: "invalid_console_section" } });
      const invalidCursor = await handler(new Request("http://localhost/api/console/work?cursor=not-json"));
      expect(invalidCursor.status).toBe(400);
      expect(await invalidCursor.json()).toMatchObject({ error: { code: "invalid_request" } });
    } finally {
      await h.close();
    }
  });

  it("rejects mutation methods, foreign hosts and malformed inputs without changing the ledger", async () => {
    const h = await fresh();
    try {
      const handler = createTasqInspectorHandler(h);
      const before = await listEvents(h.db, { tenantId: h.workspaceId });
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        const denied = await handler(new Request("http://127.0.0.1/api/index", { method }));
        expect(denied.status).toBe(405);
        expect(denied.headers.get("allow")).toBe("GET, HEAD");
        expect((await denied.json()) as unknown).toEqual({
          error: {
            code: "method_not_allowed",
            message: "This surface is read-only. Only GET and HEAD are accepted.",
          },
        });
      }
      expect(await listEvents(h.db, { tenantId: h.workspaceId })).toEqual(before);

      const rebound = await handler(new Request("http://attacker.example/"));
      expect(rebound.status).toBe(421);
      expect(rebound.headers.get("date")).toBe("Thu, 01 Jan 1970 00:00:50 GMT");
      expect(await rebound.text()).not.toContain(h.commitment.title);
      const badStatus = await handler(new Request("http://localhost/api/index?status=pwned"));
      expect(badStatus.status).toBe(400);
      expect(await badStatus.json()).toMatchObject({ error: { code: "invalid_request" } });
      const badLimit = await handler(new Request("http://localhost/?limit=101"));
      expect(badLimit.status).toBe(400);
      const badId = await handler(new Request("http://localhost/commitments/not-a-uuid"));
      expect(badId.status).toBe(400);
      const missing = await handler(new Request("http://localhost/not-found"));
      expect(missing.status).toBe(404);

      const head = await handler(new Request("http://localhost/", { method: "HEAD" }));
      expect(head.status).toBe(200);
      expect(await head.text()).toBe("");
      expectSecurityHeaders(head);
    } finally {
      await h.close();
    }
  });

  it("escapes every actor-provided audit field while showing linked record identities", async () => {
    const h = await fresh();
    try {
      const base = await inspectCommitment(h.db, h.commitment.id, {
        workspaceId: h.workspaceId,
        clock: h.clock,
      });
      expect(base).not.toBeNull();
      const injection = `<script>globalThis.pwned=true</script>`;
      const snapshot = {
        ...base!,
        conditions: [{
          id: "wait-1", status: "waiting", type: { uri: injection, schemaVersion: 1 },
          evaluator: { uri: "urn:evaluator:test", version: 1 }, notBefore: 1, deadlineAt: null,
          parameters: { hostile: injection },
        }],
        observations: [{
          id: "observation-1", type: { uri: "urn:observation:test", schemaVersion: 1 },
          payload: { hostile: injection },
        }],
        reconciliations: [{
          id: "reconciliation-1", conditionId: "wait-1", observationId: "observation-1",
          decision: "matched", effect: "satisfy", reconciledAt: 2,
          explanation: injection, reasonCode: "fixture",
        }],
        effects: [{
          id: "effect-1", status: "proposed", type: { uri: "urn:effect:test", schemaVersion: 1 },
          requestDigest: "sha256:request", connector: { operationUri: "urn:connector:test", operationVersion: 1 },
          revision: 1, request: { hostile: injection },
        }],
        effectApprovals: [{
          id: "approval-1", effectId: "effect-1", decision: "approved", decidedAt: 3,
          approverPrincipalId: injection, verificationLevel: "authenticated_context",
          verificationMethod: injection, expiresAt: null, scope: { hostile: injection }, limits: {},
        }],
        effectReceipts: [{
          id: "receipt-1", effectId: "effect-1", outcome: "committed", recordedAt: 4,
          externalReceiptId: injection, receiptDigest: "sha256:receipt", evidenceId: "evidence-1",
          report: { hostile: injection },
        }],
      } as unknown as CommitmentInspection;
      const html = renderCommitmentPage(snapshot);
      for (const id of ["wait-1", "observation-1", "reconciliation-1", "effect-1", "approval-1", "receipt-1"]) {
        expect(html).toContain(id);
      }
      expect(html).not.toContain(injection);
      expect(html).toContain("&lt;script&gt;globalThis.pwned=true&lt;/script&gt;");
    } finally {
      await h.close();
    }
  });

  it("returns readable internal errors and reports them only to the host callback", async () => {
    let reported: unknown;
    const handler = createTasqInspectorHandler({
      db: {} as never,
      workspaceId: "inspection/error",
      clock: createMutableClock(1),
      onError(error) { reported = error; },
    });
    const response = await handler(new Request("http://localhost/api/index"));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: {
        code: "internal_error",
        message: "The inspector could not build this read projection.",
      },
    });
    expect(reported).toBeInstanceOf(Error);
  });
});

describe("Tasq inspector listener boundary", () => {
  it("binds only loopback, exposes the actual ephemeral port and stops cleanly", async () => {
    const h = await fresh();
    try {
      for (const host of ["0.0.0.0", "192.168.1.5", "tasq.example"]) {
        expect(() => assertLoopbackHost(host)).toThrow(/only accepts a loopback host/);
      }
      expect(assertLoopbackHost("LOCALHOST")).toBe("localhost");
      const server = startTasqInspectorServer({
        db: h.db,
        workspaceId: h.workspaceId,
        clock: h.clock,
        hostname: "127.0.0.1",
        port: 0,
      });
      try {
        expect(server.port).toBeGreaterThan(0);
        expect(server.url).toBe(`http://127.0.0.1:${server.port}`);
        const response = await fetch(`${server.url}/api/index`);
        expect(response.status).toBe(200);
        expectSecurityHeaders(response);
      } finally {
        await server.stop();
      }
    } finally {
      await h.close();
    }
  });
});
