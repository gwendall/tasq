/** UK-009 black-box proof: a package-independent client cold-starts from discovery only. */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getDiscoverySchema,
  getTasqDiscovery,
  negotiateOnboarding,
  openDb,
  runMigrations,
} from "@tasq-internal/local-service";

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe("UK-009 unfamiliar client onboarding", () => {
  it("discovers, verifies and negotiates every installed capability without Tasq or domain imports", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tasq-machine-onboarding-"));
    tmpDirs.push(dir);
    const { db, client, close } = await openDb({ url: `file:${join(dir, "db.sqlite")}`, wal: false });
    try {
      await runMigrations(client, { now: 1_000 });
      const document = await getTasqDiscovery(db, {
        workspaceId: "gwendall",
        capabilityProfile: "compatibility",
        transportBoundary: "authenticated_remote",
        now: 2_000,
      });
      const schemas = [];
      for (const type of document.extensions.flatMap((extension) => extension.types)) {
        schemas.push(await getDiscoverySchema(db, type.resourceId, { workspaceId: "gwendall" }));
      }

      const clientFixture = new URL("./fixtures/cold-start-client.ts", import.meta.url).pathname;
      const fixtureSource = readFileSync(clientFixture, "utf8");
      expect(fixtureSource).not.toContain("@kami/");
      for (const forbidden of ["gmail", "github", "mercury", "filesystem", "http.check", "_life"]) {
        expect(fixtureSource.toLowerCase()).not.toContain(forbidden);
      }
      const child = Bun.spawn([process.execPath, "run", clientFixture], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      child.stdin.write(JSON.stringify({ document, schemas }));
      child.stdin.end();
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(exitCode, stderr).toBe(0);
      const hello = JSON.parse(stdout) as unknown;
      const response = negotiateOnboarding(document, hello);
      expect(response).toMatchObject({
        status: "compatible",
        selectedProtocolVersion: 1,
        compatibilityDigest: document.compatibilityDigest,
        problems: [],
      });
      expect(response.capabilities).toHaveLength(document.capabilities.length);
      expect(response.types).toHaveLength(document.extensions.flatMap((extension) => extension.types).length);
      expect(response.cursors).toHaveLength(document.cursors.length);
    } finally {
      await close();
    }
  });
});
