/**
 * The release chain kept breaking on blocks pinned to the previous release.
 * These prove the preflight refuses a tag while any of them is stale, and that
 * it accepts once they are advanced together.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { STORE_FORMAT_COMPATIBILITY } from "@tasq-internal/local-service";

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
  // A properly prepared release carries a migration certification describing the
  // format it ships. The stale-format case is its own test below.
  policy.sourceCandidateCheckpoint.protectedMigrationCandidate.targetStoreFormat =
    STORE_FORMAT_COMPATIBILITY.current;
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

  test("refuses a tag whose migration certification describes an older store format", async () => {
    // This block goes stale on a different axis from the version-pinned ones:
    // only when the store format moves, which is rare, which is exactly why it
    // went unread until a format bump was already on main.
    const root = await afterPublication("9.9.9");
    try {
      const file = join(root, policyPath);
      const policy = JSON.parse(await readFile(file, "utf8"));
      policy.releaseAuthorization.version = "9.9.10";
      policy.certificationPrograms.tq616SignedStatements.version = "9.9.10";
      policy.sourceCandidateCheckpoint.protectedMigrationCandidate.targetStoreFormat =
        STORE_FORMAT_COMPATIBILITY.current - 1;
      // This is the no-waiver path; the waiver has its own test.
      delete policy.sourceCandidateCheckpoint.migrationCertificationWaiver;
      await writeFile(file, `${JSON.stringify(policy, null, 2)}\n`, "utf8");

      const refused = await run(["--version", "9.9.10"], root);
      expect(refused.exitCode).not.toBe(0);
      expect(refused.stderr).toContain("protectedMigrationCandidate.targetStoreFormat");
      expect(refused.stderr).toContain(String(STORE_FORMAT_COMPATIBILITY.current));
      // The fix has to be named: nobody would guess that a passed certification
      // is the thing standing between them and a tag.
      expect(refused.stderr).toContain("Re-run the protected migration certification");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("accepts a waiver that names the shipping format, and refuses one that does not", async () => {
    // Before a release has adopters there are no published stores to protect, so
    // re-running the certification proves nothing. Record the decision rather
    // than editing the certification to claim more than it proved.
    const root = await afterPublication("9.9.9");
    try {
      const file = join(root, policyPath);
      const policy = JSON.parse(await readFile(file, "utf8"));
      policy.releaseAuthorization.version = "9.9.10";
      policy.certificationPrograms.tq616SignedStatements.version = "9.9.10";
      policy.sourceCandidateCheckpoint.protectedMigrationCandidate.targetStoreFormat =
        STORE_FORMAT_COMPATIBILITY.current - 1;
      policy.sourceCandidateCheckpoint.migrationCertificationWaiver = {
        storeFormat: STORE_FORMAT_COMPATIBILITY.current,
        reason: "No published store exists at this format, so the certification would prove nothing yet.",
        withdrawWhen: "Before the first release published while a third party holds a store.",
      };
      await writeFile(file, `${JSON.stringify(policy, null, 2)}\n`, "utf8");

      const accepted = await run(["--version", "9.9.10"], root);
      expect(accepted.exitCode, accepted.stderr).toBe(0);
      expect(JSON.parse(accepted.stdout).migrationCertificationWaived).toBe(true);

      // A waiver for a format this source does not write covers nothing. Without
      // this the block would silently outlive the situation it was written for.
      policy.sourceCandidateCheckpoint.migrationCertificationWaiver.storeFormat =
        STORE_FORMAT_COMPATIBILITY.current - 1;
      await writeFile(file, `${JSON.stringify(policy, null, 2)}\n`, "utf8");
      const refused = await run(["--version", "9.9.10"], root);
      expect(refused.exitCode).not.toBe(0);
      expect(refused.stderr).toContain("targetStoreFormat");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("refuses a waiver that does not say why or what ends it", async () => {
    const root = await afterPublication("9.9.9");
    try {
      const file = join(root, policyPath);
      const policy = JSON.parse(await readFile(file, "utf8"));
      policy.releaseAuthorization.version = "9.9.10";
      policy.certificationPrograms.tq616SignedStatements.version = "9.9.10";
      policy.sourceCandidateCheckpoint.migrationCertificationWaiver = {
        storeFormat: STORE_FORMAT_COMPATIBILITY.current,
        reason: "too short",
        withdrawWhen: "never",
      };
      await writeFile(file, `${JSON.stringify(policy, null, 2)}\n`, "utf8");

      const refused = await run(["--version", "9.9.10"], root);
      expect(refused.exitCode).not.toBe(0);
      expect(refused.stderr).toContain("must state why");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("refuses a tag whose migration certification did not pass", async () => {
    const root = await afterPublication("9.9.9");
    try {
      const file = join(root, policyPath);
      const policy = JSON.parse(await readFile(file, "utf8"));
      policy.releaseAuthorization.version = "9.9.10";
      policy.certificationPrograms.tq616SignedStatements.version = "9.9.10";
      policy.sourceCandidateCheckpoint.protectedMigrationCandidate.status = "failed";
      delete policy.sourceCandidateCheckpoint.migrationCertificationWaiver;
      await writeFile(file, `${JSON.stringify(policy, null, 2)}\n`, "utf8");

      const refused = await run(["--version", "9.9.10"], root);
      expect(refused.exitCode).not.toBe(0);
      expect(refused.stderr).toContain("status is failed, not passed");
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
