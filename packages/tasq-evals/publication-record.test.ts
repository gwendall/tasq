/**
 * The mirror of the release preflight. Version-pinned material splits in two,
 * and only the before-tag half had a gate; the after-publication half is why
 * the comparison contract sat a full release behind twice in a row.
 */

import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
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

/**
 * Build the OUTSIDE of the check: a real repository carrying real tags.
 *
 * The gate measures the record against the newest release tag, so a fixture
 * that only writes JSON is testing half of it. These are actual `git tag`
 * calls on an actual repository, because the thing being tested is precisely
 * that the reference point is not a field someone can edit.
 */
function tagged(root: string, tags: string[]) {
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "fixture@tasq.invalid",
      GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "fixture@tasq.invalid",
    },
  });
  git("init", "--quiet");
  git("commit", "--quiet", "--allow-empty", "-m", "fixture");
  for (const tag of tags) git("tag", tag);
}

/** A tree recorded as having published `version`, with every surface current. */
async function recorded(version: string, tags: string[] = [`v${version}`]) {
  const root = await mkdtemp(join(tmpdir(), "tasq-publication-"));
  for (const relative of MIRRORED) {
    const target = join(root, relative);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, await readFile(join(productRoot, relative), "utf8"), "utf8");
  }
  const policyFile = join(root, MIRRORED[0]);
  const policy = JSON.parse(await readFile(policyFile, "utf8"));
  policy.publishedRelease.version = version;
  // The fixture declares its own outside world rather than inheriting the real
  // one: a retirement copied in from the live policy names a tag this tree has
  // never heard of.
  policy.retiredReleases = [];
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
  tagged(root, tags);
  return root;
}

describe("publication record", () => {
  test("holds for THIS repository, not only for fabricated trees", async () => {
    // Every case below builds its own tree, which is how a gate can be fully
    // covered and still never look at the repository it exists to protect.
    // v0.5.1 published, the record kept saying 0.4.2, install-v0.5.1.sh 404'd,
    // and this suite was green throughout.
    const accepted = await run(productRoot);
    expect(accepted.exitCode, accepted.stderr).toBe(0);
    expect(JSON.parse(accepted.stdout)).toMatchObject({
      contractVersion: "tasq.publication-record.v1",
      ok: true,
    });
  });

  test("refuses a record left behind the newest release tag, naming both", async () => {
    // The v0.5.1 shape exactly: the tag exists, the record still says 0.4.2,
    // and every surface agrees with the record - so every other check passes.
    const root = await recorded("9.9.8", ["v9.9.8", "v9.9.9"]);
    try {
      const refused = await run(root);
      expect(refused.exitCode).not.toBe(0);
      expect(refused.stderr).toContain("policy.publishedRelease.version is 9.9.8");
      expect(refused.stderr).toContain("newest release tag is v9.9.9");
      // Both ways out have to be named, because from inside the repository the
      // two are indistinguishable: caught up, or the tag published nothing.
      expect(refused.stderr).toContain("policy.retiredReleases");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("accepts a newer tag that is recorded as having published nothing", async () => {
    const root = await recorded("9.9.8", ["v9.9.8", "v9.9.9"]);
    try {
      const policyFile = join(root, MIRRORED[0]);
      const policy = JSON.parse(await readFile(policyFile, "utf8"));
      policy.retiredReleases = [{
        tag: "v9.9.9",
        reason: "The tag failed before publishing anything, and tag protection refuses to delete it.",
      }];
      await writeFile(policyFile, `${JSON.stringify(policy, null, 2)}\n`, "utf8");

      const accepted = await run(root);
      expect(accepted.exitCode, accepted.stderr).toBe(0);
      expect(JSON.parse(accepted.stdout).retiredReleases).toEqual(["v9.9.9"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("refuses a retirement that is fiction, or that does not say why", async () => {
    const root = await recorded("9.9.9");
    try {
      const policyFile = join(root, MIRRORED[0]);
      const policy = JSON.parse(await readFile(policyFile, "utf8"));
      // Retiring a tag is how a version stops counting, so it is the one place
      // an unchecked claim would decide what "published" means.
      policy.retiredReleases = [{ tag: "v9.9.7", reason: "no" }];
      await writeFile(policyFile, `${JSON.stringify(policy, null, 2)}\n`, "utf8");

      const refused = await run(root);
      expect(refused.exitCode).not.toBe(0);
      expect(refused.stderr).toContain("v9.9.7, which is not a tag in this repository");
      expect(refused.stderr).toContain("must say why it published nothing");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

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
