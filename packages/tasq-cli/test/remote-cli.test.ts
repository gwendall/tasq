import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "index.ts");
const sha = (value: string) => `sha256:${value.repeat(64)}`;
let root: string | null = null;

// This black-box journey starts five independent CLI processes. Keep a
// deliberate process-level budget instead of inheriting Bun's 5-second unit
// default, which becomes flaky after package clean-room certification.
setDefaultTimeout(30_000);

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = null;
});

async function run(home: string, endpoint: string, args: string[], extraEnv: Record<string, string> = {}) {
  const child = Bun.spawn(["bun", "run", CLI, ...args], {
    env: {
      ...process.env,
      HOME: home,
      TASQ_HOME: join(home, ".tasq"),
      TASQ_SERVER_ENDPOINT: endpoint,
      ...extraEnv,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe("TQ-809 remote CLI", () => {
  test("enrolls, reads, mutates with explicit identity, and logs out without deleting server state", async () => {
    root = mkdtempSync(join(tmpdir(), "tasq-remote-cli-"));
    const accessToken = "tasq_access_cli_secret".padEnd(48, "x");
    let commitments = [{
      id: "commitment-one",
      workspaceId: "team/alpha",
      title: "Coordinate release",
      status: "open",
      revision: 1,
      createdAt: 10,
      updatedAt: 10,
    }];
    const calls: Request[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        calls.push(request.clone());
        const url = new URL(request.url);
        const base = {
          requestId: request.headers.get("x-tasq-request-id") ?? "generated",
          decisionId: sha("a"),
          evaluatedAt: 20,
        };
        if (url.pathname.endsWith("/enrollments/redeem")) {
          return Response.json({
            contractVersion: "tasq.remote-enrollment.v1",
            requestId: base.requestId,
            credentialId: "credential-cli",
            workspaceId: "team/alpha",
            principalId: "agent-cli",
            clientKind: "workload_agent",
            accessToken,
            issuedAt: 10,
            expiresAt: 4_000_000_000_000,
            actionUpperBound: [{
              uri: "urn:tasq:action:workspace.read",
              version: 1,
              implementationDigest: sha("b"),
            }],
          }, { status: 201 });
        }
        if (request.headers.get("authorization") !== `Bearer ${accessToken}`) {
          return Response.json({
            contractVersion: "tasq.hosted-problem.v1",
            code: "invalid_token",
            requestId: base.requestId,
            decisionId: null,
          }, { status: 401 });
        }
        if (url.pathname === "/v1/operations") {
          return Response.json({
            contractVersion: "tasq.hosted-operation-catalog.v1",
            operations: [],
          });
        }
        if (url.pathname.endsWith("/commitments") && request.method === "GET") {
          return Response.json({
            contractVersion: "tasq.hosted-commitment-page.v1",
            ...base,
            items: commitments,
            nextCursor: null,
          });
        }
        if (url.pathname.endsWith("/operations/commitment.propose") && request.method === "POST") {
          const item = {
            id: "commitment-two",
            workspaceId: "team/alpha",
            title: "Second",
            status: "open",
            revision: 1,
            createdAt: 20,
            updatedAt: 20,
          };
          commitments = [...commitments, item];
          return Response.json({
            contractVersion: "tasq.hosted-mutation-response.v1",
            requestId: request.headers.get("x-tasq-request-id"),
            decisionId: sha("e"),
            evaluatedAt: 20,
            authorityRevision: 1,
            outcome: {
              contractVersion: "tasq.hosted-mutation-outcome.v1",
              workspaceId: "team/alpha",
              operationId: "commitment.propose",
              requestDigest: sha("c"),
              idempotencyKeyDigest: sha("d"),
              resultType: "commitment",
              resultId: item.id,
              resultRevision: 1,
              eventSequence: 2,
              replayed: false,
              result: item,
            },
          });
        }
        return new Response("missing", { status: 404 });
      },
    });
    const endpoint = `http://127.0.0.1:${server.port}/`;
    try {
      const enroll = await run(root, endpoint, [
        "remote", "enroll",
        "--endpoint", endpoint,
        "--workspace", "team/alpha",
        "--profile", "machine-a",
        "--json",
      ], {
        TASQ_ENROLLMENT_TOKEN: "tasq_enroll_cli_secret".padEnd(48, "z"),
      });
      expect(enroll.exitCode).toBe(0);
      expect(JSON.parse(enroll.stdout)).toMatchObject({
        profile: "machine-a",
        principalId: "agent-cli",
        workspaceId: "team/alpha",
      });
      expect(enroll.stdout).not.toContain(accessToken);
      const profilePath = join(root, ".tasq", "remote", "machine-a.json");
      expect(statSync(profilePath).mode & 0o777).toBe(0o600);
      expect(readFileSync(profilePath, "utf8")).toContain(accessToken);

      const list = await run(root, endpoint, [
        "remote", "list", "--profile", "machine-a", "--json",
      ]);
      expect(list.exitCode).toBe(0);
      expect(JSON.parse(list.stdout).items).toHaveLength(1);

      const mutate = await run(root, endpoint, [
        "remote", "call", "commitment.propose",
        "--profile", "machine-a",
        "--resource-kind", "workspace",
        "--resource-id", "team/alpha",
        "--input", JSON.stringify({ title: "Second" }),
        "--idempotency-key", "cli-call-one",
        "--request-id", "cli-request-one",
        "--json",
      ]);
      expect(mutate.exitCode).toBe(0);
      expect(JSON.parse(mutate.stdout)).toMatchObject({ resultId: "commitment-two" });
      const mutationRequest = calls.find((request) => request.url.endsWith("/operations/commitment.propose"));
      expect(mutationRequest?.headers.get("idempotency-key")).toBe("cli-call-one");
      expect(mutationRequest?.headers.get("x-tasq-request-id")).toBe("cli-request-one");

      const logout = await run(root, endpoint, [
        "remote", "logout", "--profile", "machine-a", "--json",
      ]);
      expect(logout.exitCode).toBe(0);
      expect(JSON.parse(logout.stdout)).toMatchObject({
        removed: true,
        serverCredentialRevoked: false,
      });
      expect(commitments).toHaveLength(2);
      const after = await run(root, endpoint, [
        "remote", "list", "--profile", "machine-a", "--json",
      ]);
      expect(after.exitCode).not.toBe(0);
      expect(after.stderr).toContain("does not exist");
    } finally {
      server.stop(true);
    }
  });
});
