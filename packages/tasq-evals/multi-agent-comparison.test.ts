import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const comparison = JSON.parse(readFileSync(
  resolve(root, "docs/contracts/TQ-621_MULTI_AGENT_COMPARISON.json"),
  "utf8",
)) as {
  contractVersion: string;
  checkedAt: string;
  tasqClaimBoundary: {
    version: string;
    shape: string;
    localSameMachineOnly: boolean;
    remoteServerShipped: boolean;
    managedCloudAvailable: boolean;
    sourceCandidatesExcluded: string[];
  };
  sources: Array<{ id: string; owner: string; title: string; url: string }>;
  systems: Array<{
    id: string;
    name: string;
    sourceIds: string[];
    inference: boolean;
    parallelBehavior: string;
    collisionBoundary: string;
    completionBoundary: string;
    scopeBoundary: string;
  }>;
};
const releasePolicy = JSON.parse(readFileSync(
  resolve(root, "docs/releases/PUBLIC_RELEASE_POLICY.json"),
  "utf8",
)) as { publishedRelease: null | { version: string } };
const productMatrix = JSON.parse(readFileSync(
  resolve(root, "docs/concepts/PRODUCT_SURFACE_MATRIX.json"),
  "utf8",
)) as { productShapes: Array<{ id: string; publiclyDistributed: boolean }> };

describe("TQ-621 multi-agent backlog comparison", () => {
  test("pins the comparison to published Local and Server truth", () => {
    expect(comparison).toMatchObject({
      contractVersion: "tasq.multi-agent-backlog-comparison.v1",
      checkedAt: "2026-08-11",
      tasqClaimBoundary: {
        version: releasePolicy.publishedRelease?.version,
        shape: "Tasq Local and self-hosted Tasq Server",
        localSameMachineOnly: true,
        remoteServerShipped: true,
        managedCloudAvailable: false,
        sourceCandidatesExcluded: [],
      },
    });
    expect(productMatrix.productShapes.find(({ id }) => id === "local")?.publiclyDistributed).toBe(true);
    expect(productMatrix.productShapes.find(({ id }) => id === "server")?.publiclyDistributed).toBe(true);
    expect(productMatrix.productShapes.find(({ id }) => id === "cloud")?.publiclyDistributed).toBe(false);
  });

  test("makes every system claim traceable and every classification explicit", () => {
    const sourceIds = new Set(comparison.sources.map(({ id }) => id));
    expect(comparison.sources.length).toBeGreaterThanOrEqual(10);
    expect(comparison.systems.map(({ id }) => id)).toEqual([
      "tasq-local",
      "claude-agent-teams",
      "beads",
      "github-copilot",
      "github-fleet",
      "codex-app",
      "cursor-background",
      "mcp-a2a",
    ]);

    for (const source of comparison.sources) {
      expect(source.url, `${source.id}: source must be HTTPS`).toStartWith("https://");
      expect(source.owner.length).toBeGreaterThan(1);
      expect(source.title.length).toBeGreaterThan(3);
    }
    for (const system of comparison.systems) {
      expect(typeof system.inference, `${system.id}: inference label absent`).toBe("boolean");
      expect(system.sourceIds.length, `${system.id}: unsourced`).toBeGreaterThan(0);
      for (const sourceId of system.sourceIds) {
        expect(sourceIds.has(sourceId), `${system.id}: unknown source ${sourceId}`).toBe(true);
      }
      for (const claim of [system.parallelBehavior, system.collisionBoundary, system.completionBoundary, system.scopeBoundary]) {
        expect(claim.length, `${system.id}: underspecified claim`).toBeGreaterThan(40);
      }
    }
  });

  test("does not turn execution protocols or managed Cloud into shipped Tasq features", () => {
    const tasq = comparison.systems.find(({ id }) => id === "tasq-local");
    const protocols = comparison.systems.find(({ id }) => id === "mcp-a2a");
    expect(tasq?.scopeBoundary).toContain("published self-hosted Server");
    expect(tasq?.scopeBoundary).toContain("managed Cloud is unavailable");
    expect(tasq?.completionBoundary).toContain("does not complete");
    expect(protocols).toMatchObject({ inference: true });
    expect(protocols?.completionBoundary).toContain("separate organizational commitment decision");
  });
});
