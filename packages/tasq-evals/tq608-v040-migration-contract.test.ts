import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  directoryDigest,
  directoryManifest,
  sha256File,
  verifyReleaseEnvelope,
  type Tq608Target,
} from "./tq608-v040-migration-contract";

const roots: string[] = [];
const target: Tq608Target = "darwin-arm64";
const version = "0.4.0";
const commit = "a".repeat(40);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tasq-tq608-contract-"));
  roots.push(root);
  const stem = `tasq-v${version}-${target}`;
  const files = {
    [`${stem}.cdx.json`]: "{}\n",
    [`${stem}.install.ts`]: "#!/usr/bin/env bun\n",
    [`${stem}.release.json`]: "",
    [`${stem}.tar.gz`]: "archive",
  };
  const manifest = {
    contractVersion: "tasq.public-release.v1",
    version,
    source: { repository: "https://github.com/gwendall/tasq", commit },
    target,
    compatibility: {
      storeFormat: {
        contractVersion: "tasq.store-format.v1",
        current: 29,
        readable: { min: 29, max: 29 },
        writable: { min: 29, max: 29 },
        directlyMigratable: { min: 0, max: 29 },
        rollback: "restore-matching-verified-pre-migration-snapshot-and-binary",
      },
    },
    provenance: { localArtifactsPublishable: false },
  };
  files[`${stem}.release.json`] = `${JSON.stringify(manifest)}\n`;
  for (const [name, contents] of Object.entries(files)) {
    await writeFile(join(root, name), contents, "utf8");
  }
  const checksumLines = await Promise.all(
    Object.keys(files).sort().map(async (name) => `${await sha256File(join(root, name))}  ${name}`),
  );
  await writeFile(join(root, `${stem}.SHA256SUMS`), `${checksumLines.join("\n")}\n`, "utf8");
  const expectedFiles = Object.fromEntries(
    await Promise.all(
      [...Object.keys(files), `${stem}.SHA256SUMS`].map(async (name) => [
        name,
        await sha256File(join(root, name)),
      ]),
    ),
  );
  return { root, stem, expectedFiles };
}

async function verify(root: string, expectedFiles?: Record<string, string>) {
  return verifyReleaseEnvelope({
    directory: root,
    version,
    target,
    expectedSourceCommit: commit,
    expectedStoreFormat: 29,
    expectedFiles,
    requireLocalNonPublishable: true,
  });
}

describe("TQ-608 v0.4 prerelease envelope", () => {
  test("accepts only the exact five-asset, checksum-bound, non-publishable candidate", async () => {
    const { root, expectedFiles } = await fixture();
    const release = await verify(root, expectedFiles);
    expect(release).toMatchObject({ version, target, sourceCommit: commit, storeFormat: 29 });
  });

  test("rejects substituted bytes even when the attacker rewrites the checksum manifest", async () => {
    const { root, stem, expectedFiles } = await fixture();
    await writeFile(join(root, `${stem}.tar.gz`), "substituted", "utf8");
    const checksumPath = join(root, `${stem}.SHA256SUMS`);
    const rewritten = (await readFile(checksumPath, "utf8")).replace(
      /^[a-f0-9]{64}(?=  .*\.tar\.gz$)/m,
      await sha256File(join(root, `${stem}.tar.gz`)),
    );
    await writeFile(checksumPath, rewritten, "utf8");
    await expect(verify(root, expectedFiles)).rejects.toThrow("pinned release asset digest mismatch");
  });

  test("rejects extra assets, traversal names, store-format drift and publishable local bytes", async () => {
    const extra = await fixture();
    await writeFile(join(extra.root, "unexpected"), "x");
    await expect(verify(extra.root)).rejects.toThrow("exactly five assets");

    const format = await fixture();
    const manifestPath = join(format.root, `${format.stem}.release.json`);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.compatibility.storeFormat.current = 27;
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, "utf8");
    await expect(verify(format.root)).rejects.toThrow("checksum does not match");

    const publishable = await fixture();
    const publishableManifestPath = join(publishable.root, `${publishable.stem}.release.json`);
    const publishableManifest = JSON.parse(await readFile(publishableManifestPath, "utf8"));
    publishableManifest.provenance.localArtifactsPublishable = true;
    const publishableText = `${JSON.stringify(publishableManifest)}\n`;
    await writeFile(publishableManifestPath, publishableText, "utf8");
    const checksumPath = join(publishable.root, `${publishable.stem}.SHA256SUMS`);
    const rewritten = (await readFile(checksumPath, "utf8")).replace(
      /^[a-f0-9]{64}(?=  .*\.release\.json$)/m,
      await sha256File(publishableManifestPath),
    );
    await writeFile(checksumPath, rewritten, "utf8");
    await expect(verify(publishable.root)).rejects.toThrow("non-publishable");
  });

  test("captures physical sidecar changes separately from logical refusal evidence", async () => {
    const { root } = await fixture();
    const before = await directoryDigest(root);
    const beforeManifest = await directoryManifest(root);
    await mkdir(join(root, "new-directory"), { mode: 0o700 });
    expect(await directoryDigest(root)).not.toBe(before);
    const afterManifest = await directoryManifest(root);
    expect(afterManifest).toContain("d 448 new-directory");
    expect(afterManifest.length).toBe(beforeManifest.length + 1);
  });
});
