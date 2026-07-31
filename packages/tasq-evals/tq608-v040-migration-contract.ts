import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

export type Tq608Target = "darwin-arm64" | "linux-x64-gnu";

export interface PinnedRelease {
  version: string;
  sourceCommit: string;
  storeFormat: number;
  targets: Record<Tq608Target, Record<string, string>>;
}

interface PublicReleaseManifest {
  contractVersion: string;
  version: string;
  source: { repository: string; commit: string };
  target: string;
  compatibility: {
    storeFormat: {
      contractVersion: string;
      current: number;
      readable: { min: number; max: number };
      writable: { min: number; max: number };
      directlyMigratable: { min: number; max: number };
      rollback: string;
    };
  };
  provenance: { localArtifactsPublishable: boolean };
}

export interface VerifiedReleaseEnvelope {
  directory: string;
  version: string;
  target: Tq608Target;
  sourceCommit: string;
  storeFormat: number;
  stem: string;
  archive: string;
  checksums: string;
  installer: string;
  manifest: string;
  manifestDocument: PublicReleaseManifest;
  files: Record<string, string>;
}

export function currentTarget(): Tq608Target | null {
  if (process.platform === "darwin" && process.arch === "arm64") return "darwin-arm64";
  if (process.platform === "linux" && process.arch === "x64") return "linux-x64-gnu";
  return null;
}

export async function sha256File(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(await readFile(path));
  return hasher.digest("hex");
}

function requireSafeAssetName(name: string): void {
  if (basename(name) !== name || name === "." || name === ".." || name.includes("\0")) {
    throw new Error(`unsafe release asset name: ${JSON.stringify(name)}`);
  }
}

function parseChecksums(text: string): Map<string, string> {
  if (!text.endsWith("\n")) throw new Error("release checksum manifest must end with a newline");
  const parsed = new Map<string, string>();
  for (const line of text.slice(0, -1).split("\n")) {
    const match = /^([a-f0-9]{64})  ([^\r\n]+)$/.exec(line);
    if (match === null) throw new Error(`invalid release checksum line: ${JSON.stringify(line)}`);
    const [, digest, name] = match;
    requireSafeAssetName(name!);
    if (parsed.has(name!)) throw new Error(`duplicate release checksum entry: ${name}`);
    parsed.set(name!, digest!);
  }
  return parsed;
}

function validateStoreFormat(
  actual: PublicReleaseManifest["compatibility"]["storeFormat"],
  expected: number,
): void {
  if (
    actual.contractVersion !== "tasq.store-format.v1" ||
    actual.current !== expected ||
    actual.readable.min !== expected ||
    actual.readable.max !== expected ||
    actual.writable.min !== expected ||
    actual.writable.max !== expected ||
    actual.directlyMigratable.min !== 0 ||
    actual.directlyMigratable.max !== expected ||
    actual.rollback !== "restore-matching-verified-pre-migration-snapshot-and-binary"
  ) {
    throw new Error(`release store-format contract drift: expected exact format ${expected}`);
  }
}

export async function verifyReleaseEnvelope(input: {
  directory: string;
  version: string;
  target: Tq608Target;
  expectedSourceCommit: string;
  expectedStoreFormat: number;
  expectedFiles?: Record<string, string>;
  requireLocalNonPublishable: boolean;
}): Promise<VerifiedReleaseEnvelope> {
  const directory = resolve(input.directory);
  const stem = `tasq-v${input.version}-${input.target}`;
  const expectedNames = [
    `${stem}.cdx.json`,
    `${stem}.install.ts`,
    `${stem}.release.json`,
    `${stem}.SHA256SUMS`,
    `${stem}.tar.gz`,
  ].sort();
  const actualNames = (await readdir(directory)).sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throw new Error(`release directory must contain exactly five assets for ${stem}`);
  }

  const files: Record<string, string> = {};
  for (const name of expectedNames) {
    const path = join(directory, name);
    if (!(await stat(path)).isFile()) throw new Error(`release asset is not a file: ${name}`);
    files[name] = await sha256File(path);
  }
  if (input.expectedFiles !== undefined) {
    if (JSON.stringify(Object.keys(input.expectedFiles).sort()) !== JSON.stringify(expectedNames)) {
      throw new Error(`pinned release inventory drift for ${stem}`);
    }
    for (const name of expectedNames) {
      if (files[name] !== input.expectedFiles[name]) {
        throw new Error(`pinned release asset digest mismatch: ${name}`);
      }
    }
  }

  const checksums = join(directory, `${stem}.SHA256SUMS`);
  const checksumEntries = parseChecksums(await readFile(checksums, "utf8"));
  const checksummedNames = expectedNames.filter((name) => !name.endsWith(".SHA256SUMS"));
  if (JSON.stringify([...checksumEntries.keys()].sort()) !== JSON.stringify(checksummedNames)) {
    throw new Error(`release checksum inventory drift for ${stem}`);
  }
  for (const name of checksummedNames) {
    if (checksumEntries.get(name) !== files[name]) {
      throw new Error(`release checksum does not match asset: ${name}`);
    }
  }

  const manifest = join(directory, `${stem}.release.json`);
  const manifestDocument = JSON.parse(await readFile(manifest, "utf8")) as PublicReleaseManifest;
  if (
    manifestDocument.contractVersion !== "tasq.public-release.v1" ||
    manifestDocument.version !== input.version ||
    manifestDocument.source.repository !== "https://github.com/gwendall/tasq" ||
    manifestDocument.source.commit !== input.expectedSourceCommit ||
    manifestDocument.target !== input.target
  ) {
    throw new Error(`release identity drift for ${stem}`);
  }
  validateStoreFormat(manifestDocument.compatibility.storeFormat, input.expectedStoreFormat);
  if (
    input.requireLocalNonPublishable &&
    manifestDocument.provenance.localArtifactsPublishable !== false
  ) {
    throw new Error("local candidate release must remain explicitly non-publishable");
  }

  return {
    directory,
    version: input.version,
    target: input.target,
    sourceCommit: input.expectedSourceCommit,
    storeFormat: input.expectedStoreFormat,
    stem,
    archive: join(directory, `${stem}.tar.gz`),
    checksums,
    installer: join(directory, `${stem}.install.ts`),
    manifest,
    manifestDocument,
    files,
  };
}

export async function directoryManifest(path: string): Promise<string[]> {
  const root = resolve(path);
  const lines: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const name of (await readdir(directory)).sort()) {
      const full = join(directory, name);
      const info = await stat(full);
      const relative = full.slice(root.length + 1);
      if (info.isDirectory()) {
        lines.push(`d ${info.mode & 0o777} ${relative}`);
        await visit(full);
      } else if (info.isFile()) {
        lines.push(`f ${info.mode & 0o777} ${await sha256File(full)} ${relative}`);
      } else {
        throw new Error(`unsupported filesystem entry in certification tree: ${relative}`);
      }
    }
  }
  await visit(root);
  return lines;
}

export async function directoryDigest(path: string): Promise<string> {
  const lines = await directoryManifest(path);
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(`${lines.join("\n")}\n`);
  return hasher.digest("hex");
}
