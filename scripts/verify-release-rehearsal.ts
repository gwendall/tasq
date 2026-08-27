#!/usr/bin/env bun
/**
 * Rehearse the published-release certification BEFORE a tag exists.
 *
 * Two consecutive releases were broken by something only observable after
 * tagging. v0.5.0's preflight imported a workspace package the identity job
 * cannot resolve, because that job deliberately runs before `pnpm install`.
 * v0.5.1's migration replay expected the binary to migrate on open, which is
 * the behaviour that release removed on purpose. Each cost a version number,
 * and tag protection means a version number does not come back.
 *
 * Both were rehearsable. This builds a real installable release from the
 * working tree and runs every replay the certification job runs, against that
 * artifact. The version is fake and the commit is the working one, so it
 * proves the MECHANISM rather than the release - which is the half that keeps
 * breaking.
 *
 * What it deliberately does NOT cover, so nobody mistakes it for the
 * certification itself: no attestation, no signature verification, no npm or
 * PyPI registry replay, and only the platform it runs on.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const productRoot = resolve(import.meta.dir, "..");

/** A version no real release will ever carry, so a leaked artifact is obvious. */
const REHEARSAL_VERSION = "9.9.9";

/** Every replay the certification job runs against a downloaded artifact. */
const REPLAYS = [
  "packages/tasq-cli/test/public-lifecycle.test.ts",
  "packages/tasq-evals/published-release-replay.test.ts",
  "packages/tasq-evals/public-adoption.test.ts",
];

function currentTarget(): "darwin-arm64" | "linux-x64-gnu" {
  if (process.platform === "darwin" && process.arch === "arm64") return "darwin-arm64";
  if (process.platform === "linux" && process.arch === "x64") return "linux-x64-gnu";
  throw new Error(
    `No published target for ${process.platform}-${process.arch}. `
    + "The rehearsal builds the artifact operators actually run, so it only covers the platforms we ship.",
  );
}

async function step(label: string, command: string[], env: Record<string, string> = {}): Promise<string> {
  process.stderr.write(`\n[rehearsal] ${label}\n`);
  const child = Bun.spawn(command, {
    cwd: productRoot,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  // Streamed through rather than swallowed: a rehearsal you cannot watch is a
  // rehearsal nobody runs twice.
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  process.stderr.write(stdout);
  process.stderr.write(stderr);
  if (exitCode !== 0) throw new Error(`failed: ${label}`);
  return `${stdout}${stderr}`;
}

const target = currentTarget();
const sourceCommit = (await new Response(
  Bun.spawn(["git", "rev-parse", "HEAD"], { cwd: productRoot, stdout: "pipe" }).stdout,
).text()).trim();
if (!/^[a-f0-9]{40}$/.test(sourceCommit)) {
  throw new Error(`git rev-parse HEAD did not return a commit: ${sourceCommit}`);
}

const outdir = await mkdtemp(join(tmpdir(), "tasq-rehearsal-"));
try {
  await step(`build ${REHEARSAL_VERSION} for ${target}`, [
    process.execPath, "scripts/release/build-public-release.ts",
    "--version", REHEARSAL_VERSION,
    "--source-commit", sourceCommit,
    "--target", target,
    "--outdir", outdir,
  ]);

  const output = await step("replay the certification against it", [
    process.execPath, "test", ...REPLAYS,
  ], {
    TASQ_PUBLISHED_RELEASE_DIR: outdir,
    TASQ_PUBLISHED_RELEASE_VERSION: REHEARSAL_VERSION,
    TASQ_PUBLISHED_SOURCE_COMMIT: sourceCommit,
  });

  // The replays skip themselves when the release directory is unset, which is
  // what makes them harmless in the normal suite - and exactly what would make
  // a typo here pass in silence. A skipped test is not a failure, so a zero
  // exit code proves nothing on its own. Read the summary.
  const skipped = /\s(\d+) skip\s/.exec(output);
  const passed = /\s(\d+) pass\s/.exec(output);
  if (!passed || Number(passed[1]) === 0) {
    throw new Error("The replays reported no passing test. They skipped themselves; the artifact was never exercised.");
  }
  if (skipped && Number(skipped[1]) > 0) {
    throw new Error(
      `${skipped[1]} replay(s) skipped themselves, so the artifact was only partly exercised. `
      + "Check TASQ_PUBLISHED_RELEASE_DIR and that this platform is one we ship.",
    );
  }
} finally {
  await rm(outdir, { recursive: true, force: true });
}

process.stderr.write("\n[rehearsal] the certification loop runs on this commit\n");
