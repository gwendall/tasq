import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMutableClock } from "@tasq-run/schema";
import {
  createCommitment,
  inspectCommitment,
  listEvents,
  openDb,
  runKernelMigrations,
  type CommitmentInspection,
} from "@tasq-run/core";
import {
  assertLoopbackHost,
  createTasqInspectorHandler,
  renderCommitmentPage,
  startTasqInspectorServer,
  type ConsoleScheduler,
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
  expect(response.headers.get("content-security-policy")).toContain("script-src 'self'");
  expect(response.headers.get("content-security-policy")).not.toContain("'unsafe-inline'");
  expect(response.headers.get("content-security-policy")).not.toContain("'unsafe-eval'");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
}

class ManualScheduler implements ConsoleScheduler {
  waits = 0;
  private releases: Array<() => void> = [];

  wait(_delayMs: number, signal: AbortSignal): Promise<void> {
    this.waits++;
    return new Promise((resolve) => {
      if (signal.aborted) return resolve();
      this.releases.push(resolve);
    });
  }

  release(): void {
    this.releases.shift()?.();
  }
}

function decodeSse(chunk: Uint8Array): { event: string | null; id: string | null; data: any } {
  const text = new TextDecoder().decode(chunk);
  const line = (name: string) => text.split("\n").find((candidate) => candidate.startsWith(`${name}: `))?.slice(name.length + 2) ?? null;
  const data = line("data");
  return { event: line("event"), id: line("id"), data: data ? JSON.parse(data) : null };
}

describe("Tasq read-only inspector handler", () => {
  it("serves bounded HTML and canonical JSON with one injected snapshot clock", async () => {
    const h = await fresh();
    try {
      const handler = createTasqInspectorHandler(h);
      h.clock.set(61_000);
      const page = await handler(new Request("http://127.0.0.1/inspector"));
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

  it("renders the responsive operator Console and an exact preview-before-download support artifact", async () => {
    const h = await fresh();
    try {
      const handler = createTasqInspectorHandler(h);
      h.clock.set(64_000);
      const page = await handler(new Request("http://localhost/?view=work"));
      expect(page.status).toBe(200);
      expectSecurityHeaders(page);
      expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
      expect(page.headers.get("content-security-policy")).toContain("connect-src 'self'");
      const html = await page.text();
      expect(html).toContain("<title>Tasq Console");
      expect(html).toContain("Workspace overview");
      expect(html).toContain("Redacted support bundle");
      expect(html).toContain('src="/assets/console.js"');
      expect(html).toContain("&lt;script&gt;alert(&quot;title&quot;)&lt;/script&gt;");
      expect(html).not.toContain("Foreign workspace secret");
      expect(html).not.toContain("<form");

      const audit = await handler(new Request("http://localhost/?view=audit"));
      expect(await audit.text()).toContain("audit-timeline");
      const invalid = await handler(new Request("http://localhost/?view=secrets"));
      expect(invalid.status).toBe(400);

      const script = await handler(new Request("http://localhost/assets/console.js"));
      expect(script.headers.get("content-type")).toBe("application/javascript; charset=utf-8");
      const source = await script.text();
      expect(source).toContain("new EventSource");
      expect(source).not.toContain("Date.now");

      const preview = await handler(new Request("http://localhost/api/console/support-bundle"));
      expect(preview.status).toBe(200);
      expect(preview.headers.get("content-disposition")).toBeNull();
      const bundle = await preview.json() as any;
      expect(bundle).toMatchObject({
        contractVersion: "tasq.console-support-bundle.v1",
        generatedAt: 64_000,
        source: { authority: "canonical-local-ledger", readOnly: true },
        redaction: { policy: "tasq.operator-support-redaction.v1" },
      });
      expect(JSON.stringify(bundle)).not.toContain("Foreign workspace secret");
      expect(bundle.sections.audit.items.every((item: any) => item.payload.reason === "operator_index_redaction")).toBe(true);

      const directDownload = await handler(new Request("http://localhost/api/console/support-bundle?download=1"));
      expect(directDownload.status).toBe(400);
      expect(await directDownload.json()).toMatchObject({ error: { code: "preview_required" } });
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

      const unavailableRuntime = await handler(new Request("http://localhost/api/console/runtime"));
      expect(unavailableRuntime.status).toBe(404);
      expect(await unavailableRuntime.json()).toMatchObject({ error: { code: "runtime_unavailable" } });

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

  it("offers lossless polling and a backpressured SSE stream from the same redacted cursor", async () => {
    const h = await fresh();
    const scheduler = new ManualScheduler();
    try {
      const handler = createTasqInspectorHandler({ ...h, scheduler, livePollIntervalMs: 1 });
      h.clock.set(70_000);
      const initialResponse = await handler(new Request("http://localhost/api/console/events?limit=2"));
      expect(initialResponse.status).toBe(200);
      const initial = await initialResponse.json() as any;
      expect(initial).toMatchObject({
        contractVersion: "tasq.console-event-batch.v1",
        mode: "snapshot",
        inspectedAt: 70_000,
        returned: 0,
        snapshot: { contractVersion: "tasq.console-overview.v1" },
      });

      const streamResponse = await handler(new Request("http://localhost/api/console/stream?limit=2"));
      expect(streamResponse.status).toBe(200);
      expect(streamResponse.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
      expect(streamResponse.headers.get("x-accel-buffering")).toBe("no");
      expectSecurityHeaders(streamResponse);
      const reader = streamResponse.body!.getReader();
      const firstChunk = await reader.read();
      const first = decodeSse(firstChunk.value!);
      expect(first).toMatchObject({
        event: "snapshot",
        data: { contractVersion: "tasq.console-stream-envelope.v1", kind: "snapshot" },
      });
      expect(first.id).toBe(first.data.batch.nextCursor);

      // The stream queues at most one frame. It only schedules another read
      // once the consumer has accepted the previous chunk.
      await Promise.resolve();
      expect(scheduler.waits).toBe(1);
      h.clock.set(71_000);
      const created = await createCommitment(h.db, { title: "Live update secret body" }, {
        workspaceId: h.workspaceId, actor: "runtime", clock: h.clock,
      });
      scheduler.release();
      const changed = decodeSse((await reader.read()).value!);
      expect(changed).toMatchObject({
        event: "changes",
        data: {
          kind: "changes",
          batch: { inspectedAt: 71_000, events: [{ entityId: created.id }] },
        },
      });
      expect(JSON.stringify(changed)).not.toContain("Live update secret body");
      await reader.cancel();

      const resumed = await handler(new Request("http://localhost/api/console/events", {
        headers: { "Last-Event-ID": changed.id! },
      }));
      expect(await resumed.json()).toMatchObject({ mode: "changes", returned: 0 });
    } finally {
      await h.close();
    }
  });

  it("closes an overflowing stream with an exact bounded polling continuation", async () => {
    const h = await fresh();
    try {
      const handler = createTasqInspectorHandler({ ...h, scheduler: new ManualScheduler() });
      const initial = await (await handler(new Request("http://localhost/api/console/events"))).json() as any;
      for (const title of ["One", "Two", "Three"]) {
        h.clock.advance(1);
        await createCommitment(h.db, { title }, {
          workspaceId: h.workspaceId, actor: "runtime", clock: h.clock,
        });
      }
      const stream = await handler(new Request(
        `http://localhost/api/console/stream?limit=1&cursor=${encodeURIComponent(initial.nextCursor)}`,
      ));
      const reader = stream.body!.getReader();
      const overflow = decodeSse((await reader.read()).value!);
      expect(overflow).toMatchObject({
        event: "overflow",
        data: {
          kind: "overflow",
          batch: { returned: 1, hasMore: true },
          recovery: { transport: "poll", href: "/api/console/events" },
        },
      });
      expect(overflow.data.recovery.cursor).toBe(overflow.data.batch.nextCursor);
      expect((await reader.read()).done).toBe(true);

      const fallback = await handler(new Request(
        `http://localhost/api/console/events?limit=2&cursor=${encodeURIComponent(overflow.data.recovery.cursor)}`,
      ));
      expect(await fallback.json()).toMatchObject({ mode: "changes", returned: 2, hasMore: false });

      await h.client.execute({
        sql: "DELETE FROM event WHERE tenant_id = ?",
        args: [h.workspaceId],
      });
      const ahead = await handler(new Request(
        `http://localhost/api/console/events?cursor=${encodeURIComponent(overflow.data.recovery.cursor)}`,
      ));
      expect(ahead.status).toBe(409);
      expect(await ahead.json()).toMatchObject({
        error: {
          contractVersion: "tasq.console-live-problem.v1",
          code: "cursor_ahead",
          recovery: { action: "refresh_snapshot" },
        },
      });

      const conflict = await handler(new Request("http://localhost/api/console/stream?cursor=query", {
        headers: { "Last-Event-ID": "header" },
      }));
      expect(conflict.status).toBe(400);
      const head = await handler(new Request("http://localhost/api/console/stream", { method: "HEAD" }));
      expect(head.status).toBe(200);
      expect(await head.text()).toBe("");
    } finally {
      await h.close();
    }
  });

  it("emits a typed gap if retained history disappears after connection", async () => {
    const h = await fresh();
    const scheduler = new ManualScheduler();
    try {
      const handler = createTasqInspectorHandler({ ...h, scheduler, livePollIntervalMs: 1 });
      const stream = await handler(new Request("http://localhost/api/console/stream"));
      const reader = stream.body!.getReader();
      expect(decodeSse((await reader.read()).value!).event).toBe("snapshot");

      await createCommitment(h.db, { title: "Before pruning" }, {
        workspaceId: h.workspaceId, actor: "runtime", clock: h.clock,
      });
      await Promise.resolve();
      scheduler.release();
      expect(decodeSse((await reader.read()).value!).event).toBe("changes");

      await h.client.execute({
        sql: "DELETE FROM event WHERE tenant_id = ?",
        args: [h.workspaceId],
      });
      await createCommitment(h.db, { title: "After pruning" }, {
        workspaceId: h.workspaceId, actor: "runtime", clock: h.clock,
      });
      await Promise.resolve();
      scheduler.release();
      const gap = decodeSse((await reader.read()).value!);
      expect(gap).toMatchObject({
        event: "gap",
        id: null,
        data: {
          kind: "gap",
          problem: { code: "cursor_expired", recovery: { action: "refresh_snapshot" } },
        },
      });
      expect((await reader.read()).done).toBe(true);
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
        resolutionContracts: [{ id: "resolution-contract-1", policyUri: injection }],
        evidenceTrustRecords: [{ id: "evidence-trust-1", reason: injection }],
        completionProposals: [{ id: "completion-proposal-1", summary: injection }],
        completionChallenges: [{ id: "completion-challenge-1", explanation: injection }],
        validationDecisions: [{ id: "validation-decision-1", explanation: injection }],
      } as unknown as CommitmentInspection;
      const html = renderCommitmentPage(snapshot);
      for (const id of [
        "wait-1", "observation-1", "reconciliation-1", "effect-1", "approval-1", "receipt-1",
        "resolution-contract-1", "evidence-trust-1", "completion-proposal-1",
        "completion-challenge-1", "validation-decision-1",
      ]) {
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
      expect(() => startTasqInspectorServer({
        db: h.db,
        workspaceId: h.workspaceId,
        clock: h.clock,
        hostname: "127.0.0.1",
        port: 0,
        productVersion: "latest",
      })).toThrow(/productVersion must be SemVer/);
      const server = startTasqInspectorServer({
        db: h.db,
        workspaceId: h.workspaceId,
        clock: h.clock,
        hostname: "127.0.0.1",
        port: 0,
        productVersion: "1.2.3-test.1",
        instanceId: "018f47a2-6ce4-4b90-8f43-111111111111",
        processId: 42,
      });
      try {
        expect(server.port).toBeGreaterThan(0);
        expect(server.url).toBe(`http://127.0.0.1:${server.port}`);
        expect(server.descriptor).toMatchObject({
          contractVersion: "tasq.console-listener.v1",
          instanceId: "018f47a2-6ce4-4b90-8f43-111111111111",
          productVersion: "1.2.3-test.1",
          workspaceId: h.workspaceId,
          startedAt: h.clock.now(),
          endpoint: { url: server.url, port: server.port, scope: "loopback" },
          process: { mode: "foreground", pid: 42 },
        });
        const response = await fetch(`${server.url}/api/index`);
        expect(response.status).toBe(200);
        expectSecurityHeaders(response);
        expect(await fetch(`${server.url}/api/console/runtime`).then((value) => value.json()))
          .toEqual(server.descriptor);
      } finally {
        await server.stop();
      }
    } finally {
      await h.close();
    }
  });
});
