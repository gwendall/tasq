import { describe, expect, test } from "bun:test";
import { createRemoteTasq, redeemRemoteEnrollment, TasqRemoteError } from "../src/index.js";

const endpoint = "https://server.example/";
const workspaceId = "robotics/team-a";
const sha = (value: string) => `sha256:${value.repeat(64)}`;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("@tasq-run/client", () => {
  test("binds explicit endpoint, workspace and bearer identity to guarded reads", async () => {
    const requests: Request[] = [];
    const client = createRemoteTasq({
      endpoint,
      workspaceId,
      accessToken: "secret-token",
      requestIdFactory: () => "request-one",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        return json({
          contractVersion: "tasq.hosted-commitment-page.v1",
          requestId: "request-one",
          decisionId: sha("a"),
          evaluatedAt: 100,
          items: [{
            id: "commitment-one",
            workspaceId,
            title: "Calibrate",
            status: "open",
            revision: 1,
            createdAt: 1,
            updatedAt: 2,
          }],
          nextCursor: null,
        });
      },
    });

    const page = await client.listCommitments({ limit: 10 });
    expect(page.items[0]?.title).toBe("Calibrate");
    expect(requests[0]?.url).toBe(
      "https://server.example/v1/workspaces/robotics%2Fteam-a/commitments?limit=10",
    );
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer secret-token");
    expect(requests[0]?.headers.get("x-tasq-request-id")).toBe("request-one");
  });

  test("preserves mutation identity for exact lost-response retries", async () => {
    const seen: Array<{ key: string | null; requestId: string | null; body: string }> = [];
    let calls = 0;
    const client = createRemoteTasq({
      endpoint,
      workspaceId,
      accessToken: async () => "rotatable-token",
      requestIdFactory: () => "unused",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        seen.push({
          key: request.headers.get("idempotency-key"),
          requestId: request.headers.get("x-tasq-request-id"),
          body: await request.text(),
        });
        calls += 1;
        if (calls === 1) throw new TypeError("response lost");
        return json({
          contractVersion: "tasq.hosted-mutation-response.v1",
          requestId: "run-42-request",
          decisionId: sha("a"),
          evaluatedAt: 10,
          authorityRevision: 1,
          outcome: {
            contractVersion: "tasq.hosted-mutation-outcome.v1",
            workspaceId,
            operationId: "claim.acquire",
            requestDigest: sha("b"),
            idempotencyKeyDigest: sha("c"),
            resultType: "claim",
            resultId: "claim-one",
            resultRevision: 1,
            eventSequence: 9,
            replayed: true,
            result: { holder: "agent-one" },
          },
        });
      },
    });
    const input = {
      resource: { kind: "commitment" as const, id: "commitment-one" },
      input: { durationMs: 30_000 },
      idempotencyKey: "run-42",
      requestId: "run-42-request",
    };
    await expect(client.executeOperation("claim.acquire", input)).rejects.toMatchObject({
      code: "network_error",
      retryable: true,
    });
    const outcome = await client.executeOperation("claim.acquire", input);
    expect(outcome.replayed).toBe(true);
    expect(seen[0]).toEqual(seen[1]);
  });

  test("streams exclusive event cursors and surfaces cursor expiry recovery", async () => {
    let calls = 0;
    const client = createRemoteTasq({
      endpoint,
      workspaceId,
      accessToken: "token",
      requestIdFactory: () => `request-${calls}`,
      fetch: async (input) => {
        const url = new URL(String(input));
        calls += 1;
        if (url.searchParams.get("after") === "8") {
          return json({
            contractVersion: "tasq.hosted-problem.v1",
            code: "cursor_expired",
            requestId: "expired",
            decisionId: null,
            oldestSequence: 20,
          }, 410);
        }
        return json({
          contractVersion: "tasq.hosted-event-metadata-page.v1",
          requestId: `request-${calls}`,
          decisionId: sha("d"),
          evaluatedAt: 100,
          items: [{
            id: "event-nine",
            sequence: 9,
            entityType: "task",
            entityId: "task-one",
            eventType: "task.updated",
            actorPrincipalId: "agent",
            createdAt: 99,
          }],
          nextSequence: 9,
        });
      },
    });
    const stream = client.streamEvents({ afterSequence: 8, limit: 1, pollIntervalMs: 0 });
    await expect(stream.next()).rejects.toEqual(expect.objectContaining({
      status: 410,
      code: "cursor_expired",
      oldestSequence: 20,
    }));

    const healthy = createRemoteTasq({
      endpoint,
      workspaceId,
      accessToken: "token",
      fetch: async () => json({
        contractVersion: "tasq.hosted-event-metadata-page.v1",
        requestId: "event-page",
        decisionId: sha("e"),
        evaluatedAt: 100,
        items: [{
          id: "event-nine",
          sequence: 9,
          entityType: "task",
          entityId: "task-one",
          eventType: "task.updated",
          actorPrincipalId: null,
          createdAt: 99,
        }],
        nextSequence: 9,
      }),
    });
    const one = healthy.streamEvents({ afterSequence: 8, limit: 1, pollIntervalMs: 0 });
    expect((await one.next()).value).toMatchObject({ sequence: 9 });
    await one.return(9);
  });

  test("rejects insecure non-loopback endpoints and typed authorization failures", async () => {
    expect(() => createRemoteTasq({
      endpoint: "http://server.example/",
      workspaceId,
      accessToken: "token",
    })).toThrow("canonical HTTPS");

    const client = createRemoteTasq({
      endpoint,
      workspaceId,
      accessToken: "revoked",
      fetch: async () => json({
        contractVersion: "tasq.hosted-problem.v1",
        code: "invalid_token",
        requestId: "request-revoked",
        decisionId: null,
      }, 401),
    });
    try {
      await client.listCommitments();
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(TasqRemoteError);
      expect(error).toMatchObject({ status: 401, code: "invalid_token", retryable: false });
    }
  });

  test("redeems one enrollment without treating actor text as identity", async () => {
    let body: unknown;
    const result = await redeemRemoteEnrollment({
      endpoint,
      workspaceId,
      enrollmentToken: "tasq_enroll_secret".padEnd(40, "x"),
      requestId: "enrollment-request",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        body = await request.json();
        return json({
          contractVersion: "tasq.remote-enrollment.v1",
          requestId: "enrollment-request",
          credentialId: "credential-one",
          workspaceId,
          principalId: "principal-one",
          clientKind: "human_device",
          accessToken: "tasq_access_secret".padEnd(40, "y"),
          issuedAt: 10,
          expiresAt: 100,
          actionUpperBound: [{
            uri: "urn:tasq:action:workspace.read",
            version: 1,
            implementationDigest: sha("f"),
          }],
        }, 201);
      },
    });
    expect(body).toEqual({
      contractVersion: "tasq.remote-enrollment.v1",
      enrollmentToken: "tasq_enroll_secret".padEnd(40, "x"),
    });
    expect(result).toMatchObject({
      workspaceId,
      principalId: "principal-one",
      clientKind: "human_device",
    });
    expect(JSON.stringify(body)).not.toContain("actor");
  });
});
