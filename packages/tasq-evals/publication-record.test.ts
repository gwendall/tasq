/**
 * The mirror of the release preflight. Version-pinned material splits in two,
 * and only the before-tag half had a gate; the after-publication half is why
 * the comparison contract sat a full release behind twice in a row.
 */

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const productRoot = resolve(import.meta.dir, "../..");
const checker = join(productRoot, "scripts/release/verify-publication-recorded.ts");

const MIRRORED = [
  "docs/releases/PUBLIC_RELEASE_POLICY.json",
  "docs/contracts/TQ-621_MULTI_AGENT_COMPARISON.json",
  "apps/site/media/tasq-demo.tape",
] as const;

async function run(root: string) {
  const child = Bun.spawn([process.execPath, checker, "--policy-root", root], {
    cwd: productRoot,
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

/** A tree recorded as having published `version`, with every surface current. */
async function recorded(version: string) {
  const root = await mkdtemp(join(tmpdir(), "tasq-publication-"));
  for (const relative of MIRRORED) {
    const target = join(root, relative);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, await readFile(join(productRoot, relative), "utf8"), "utf8");
  }
  const policyFile = join(root, MIRRORED[0]);
  const policy = JSON.parse(await readFile(policyFile, "utf8"));
  policy.publishedRelease.version = version;
  await writeFile(policyFile, `${JSON.stringify(policy, null, 2)}\n`, "utf8");

  const comparisonFile = join(root, MIRRORED[1]);
  const comparison = JSON.parse(await readFile(comparisonFile, "utf8"));
  comparison.tasqClaimBoundary.version = version;
  await writeFile(comparisonFile, `${JSON.stringify(comparison, null, 2)}\n`, "utf8");

  const tapeFile = join(root, MIRRORED[2]);
  const tape = await readFile(tapeFile, "utf8");
  await writeFile(
    tapeFile,
    tape.replace(/@tasq-run\/cli@[0-9.]+ demo/, `@tasq-run/cli@${version} demo`),
    "utf8",
  );

  for (const relative of [
    `scripts/release/install-v${version}.sh`,
    `apps/site/public/install-v${version}.sh`,
  ]) {
    const target = join(root, relative);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, "#!/bin/sh\n", "utf8");
  }
  return root;
}

describe("publication record", () => {
  test("accepts a tree whose public surfaces describe the published release", async () => {
    const root = await recorded("9.9.9");
    try {
      const accepted = await run(root);
      expect(accepted.exitCode, accepted.stderr).toBe(0);
      expect(JSON.parse(accepted.stdout)).toMatchObject({
        contractVersion: "tasq.publication-record.v1",
        publishedVersion: "9.9.9",
        ok: true,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("refuses surfaces left a release behind, naming each and why it matters", async () => {
    const root = await recorded("9.9.9");
    try {
      // Exactly the drift that happened after v0.4.0 and again after v0.4.1.
      const comparisonFile = join(root, MIRRORED[1]);
      const comparison = JSON.parse(await readFile(comparisonFile, "utf8"));
      comparison.tasqClaimBoundary.version = "9.9.8";
      await writeFile(comparisonFile, `${JSON.stringify(comparison, null, 2)}\n`, "utf8");

      const tapeFile = join(root, MIRRORED[2]);
      const tape = await readFile(tapeFile, "utf8");
      await writeFile(tapeFile, tape.replace("@tasq-run/cli@9.9.9 demo", "@tasq-run/cli@9.9.8 demo"), "utf8");

      const refused = await run(root);
      expect(refused.exitCode).not.toBe(0);
      expect(refused.stderr).toContain("comparison.tasqClaimBoundary.version is 9.9.8");
      expect(refused.stderr).toContain("tasq-demo.tape does not record @tasq-run/cli@9.9.9");
      expect(refused.stderr).toContain("/compare page");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("refuses a published release whose documented installer does not exist", async () => {
    const root = await recorded("9.9.9");
    try {
      await rm(join(root, "apps/site/public/install-v9.9.9.sh"));
      const refused = await run(root);
      expect(refused.exitCode).not.toBe(0);
      // `curl .../install-vX.sh` returning 404 is what the first v0.4.1 attempt hit.
      expect(refused.stderr).toContain("install-v9.9.9.sh does not exist");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
