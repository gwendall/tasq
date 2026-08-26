/**
 * The release chain kept breaking on blocks pinned to the previous release.
 * These prove the preflight refuses a tag while any of them is stale, and that
 * it accepts once they are advanced together.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const productRoot = resolve(import.meta.dir, "../..");
const preflight = join(productRoot, "scripts/release/verify-release-preflight.ts");
const policyPath = "docs/releases/PUBLIC_RELEASE_POLICY.json";
const comparisonPath = "docs/contracts/TQ-621_MULTI_AGENT_COMPARISON.json";

async function run(args: string[], cwd: string) {
  const child = Bun.spawn([process.execPath, preflight, ...args, "--policy-root", cwd], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

/**
 * A copy of the real policy shaped as it looks after a publication: every
 * pinned block still names the released version. This is the shape that made
 * the second release impossible, so it is the shape worth testing against.
 */
async function afterPublication(released: string) {
  const root = await mkdtemp(join(tmpdir(), "tasq-preflight-"));
  for (const relative of [policyPath, comparisonPath]) {
    const target = join(root, relative);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, await readFile(join(productRoot, relative), "utf8"), "utf8");
  }
  const policyFile = join(root, policyPath);
  const policy = JSON.parse(await readFile(policyFile, "utf8"));
  policy.releaseAuthorization.version = released;
  policy.certificationPrograms.tq616SignedStatements.version = released;
  policy.publishedRelease.version = released;
  await writeFile(policyFile, `${JSON.stringify(policy, null, 2)}\n`, "utf8");

  const comparisonFile = join(root, comparisonPath);
  const comparison = JSON.parse(await readFile(comparisonFile, "utf8"));
  comparison.tasqClaimBoundary.version = released;
  await writeFile(comparisonFile, `${JSON.stringify(comparison, null, 2)}\n`, "utf8");
  return root;
}

describe("release preflight", () => {
  test("refuses a tag while any block still names the released version", async () => {
    const root = await afterPublication("9.9.9");
    try {
      const refused = await run(["--version", "9.9.10"], root);
      expect(refused.exitCode).not.toBe(0);
      // Each stale block must be named with the reason it matters, because the
      // one that escaped review is only fixable before the tag exists.
      expect(refused.stderr).toContain("policy.releaseAuthorization.version");
      expect(refused.stderr).toContain("certificationPrograms.tq616SignedStatements.version");
      expect(refused.stderr).toContain("comparison.tasqClaimBoundary.version");
      expect(refused.stderr).toContain("immutable tag");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("accepts once every block is advanced together", async () => {
    const root = await afterPublication("9.9.9");
    try {
      for (const [relative, mutate] of [
        [policyPath, (value: Record<string, any>) => {
          value.releaseAuthorization.version = "9.9.10";
          value.certificationPrograms.tq616SignedStatements.version = "9.9.10";
        }],
        [comparisonPath, (value: Record<string, any>) => {
          value.tasqClaimBoundary.version = "9.9.10";
        }],
      ] as const) {
        const file = join(root, relative);
        const parsed = JSON.parse(await readFile(file, "utf8"));
        mutate(parsed);
        await writeFile(file, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
      }
      const accepted = await run(["--version", "9.9.10"], root);
      expect(accepted.exitCode, accepted.stderr).toBe(0);
      expect(JSON.parse(accepted.stdout)).toMatchObject({
        contractVersion: "tasq.release-preflight.v1",
        version: "9.9.10",
        ok: true,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("refuses a version that is not newer than the published one", async () => {
    const root = await afterPublication("9.9.9");
    try {
      const repeated = await run(["--version", "9.9.9"], root);
      expect(repeated.exitCode).not.toBe(0);
      expect(repeated.stderr).toContain("not older than 9.9.9");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
