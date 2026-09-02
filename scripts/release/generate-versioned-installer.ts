#!/usr/bin/env bun
/**
 * Generate `install-v<version>.sh` from the release it names.
 *
 * The v0.6.0 installer was created by copying the previous one and replacing
 * the version string, so it carried the PREVIOUS release's
 * checksum-of-checksums and correctly refused to install bytes it could not
 * verify against its own pin. The only thing that caught it was running it:
 * `verify-publication-recorded` checks that the versioned installer EXISTS,
 * not that it points at the release it names.
 *
 * A stale pin should not be expressible, not merely detectable. So the digests
 * come from the published SHA256SUMS assets rather than from a human's
 * find-and-replace.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const productRoot = resolve(import.meta.dir, "../..");
const TARGETS = ["darwin-arm64", "linux-x64-gnu"] as const;

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const version = flag("--version");
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  process.stderr.write("usage: generate-versioned-installer.ts --version <x.y.z> [--from <previous>]\n");
  process.exit(2);
}

/**
 * The digest a released target's installer must pin.
 *
 * Downloaded from the release rather than recomputed locally: the pin exists to
 * bind the script to bytes GitHub is serving, and a locally rebuilt artifact is
 * not evidence about those bytes.
 */
function publishedChecksumDigest(target: string): string {
  const asset = `tasq-v${version}-${target}.SHA256SUMS`;
  const bytes = execFileSync("gh", [
    "release", "download", `v${version}`, "--pattern", asset, "--output", "-",
  ], { encoding: "buffer", maxBuffer: 8 * 1024 * 1024 });
  return createHash("sha256").update(bytes).digest("hex");
}

const previous = flag("--from");
const template = resolve(
  productRoot,
  previous
    ? `scripts/release/install-v${previous}.sh`
    : `scripts/release/install-v${version}.sh`,
);
let script = readFileSync(template, "utf8");

// Replace the version everywhere it is pinned, then every digest by position:
// the two CHECKSUMS_SHA256 assignments are darwin then linux, in that order.
script = script.replaceAll(previous ?? version, version);
const assignments = [...script.matchAll(/CHECKSUMS_SHA256="([0-9a-f]{64})"/g)];
if (assignments.length !== TARGETS.length) {
  process.stderr.write(
    `expected ${TARGETS.length} pinned digests, found ${assignments.length}. `
    + "The installer's shape changed; update this generator rather than the output.\n",
  );
  process.exit(1);
}
TARGETS.forEach((target, index) => {
  script = script.replace(assignments[index]![0], `CHECKSUMS_SHA256="${publishedChecksumDigest(target)}"`);
});

const output = resolve(productRoot, `scripts/release/install-v${version}.sh`);
writeFileSync(output, script, { encoding: "utf8", mode: 0o755 });
process.stdout.write(`${JSON.stringify({
  contractVersion: "tasq.versioned-installer.v1",
  version,
  output,
  targets: TARGETS,
  // Said out loud: this proves the pin matches what GitHub serves, and nothing
  // about whether the release itself is correct.
  proves: "the pinned digests equal the published SHA256SUMS for each target",
  ok: true,
}, null, 2)}\n`);
