/**
 * A deliberately small read-only filesystem adapter.
 *
 * It knows the normalized filesystem observation wire shape, but imports
 * neither the Tasq kernel nor its database. The caller decides where and when
 * to ingest the returned fact.
 */

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, posix, relative, resolve, sep } from "node:path";

const DEFAULT_MAX_FILE_BYTES = 16 * 1024 * 1024;
const ROOT_ALIAS = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/;

export interface WatchFilesystemOptions {
  /** Stable logical name disclosed in the fact; never an absolute path. */
  connectorRoot: string;
  /** Locally configured trust boundary. This value is never emitted. */
  rootPath: string;
  /** Portable path relative to rootPath, using forward slashes. */
  relativePath: string;
  /** Refuse to hash files larger than this bound. */
  maxFileBytes?: number;
}

export interface FilesystemObservationEnvelope {
  source: string;
  externalEventId: string;
  kind: "filesystem.stat";
  payload: {
    connectorRoot: string;
    relativePath: string;
    kind: "file" | "directory" | "other";
    sizeBytes: number | null;
    digest: string | null;
  };
  /** Filesystem mtime: domain time, not the watcher device wall clock. */
  occurredAt: number;
  verificationLevel: "authenticated_source";
  verificationMethod: "sandboxed-stat-and-sha256";
  rawRef: string;
  digest: string;
  metadata: {
    watcherContract: "tasq.filesystem-stat.v1";
    hashAlgorithm: "sha256";
  };
}

function sha256(value: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function portableRelativePath(input: string): string {
  const rawParts = input.split("/");
  if (
    !input ||
    input.includes("\0") ||
    input.includes("\\") ||
    posix.isAbsolute(input) ||
    rawParts.some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error("relativePath must be a non-empty portable relative path");
  }
  const normalized = posix.normalize(input);
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    throw new Error("relativePath escapes or does not identify an artifact");
  }
  return normalized;
}

function safeUnixMs(value: number): number {
  const integer = Math.trunc(value);
  if (!Number.isSafeInteger(integer) || integer < 0) {
    throw new Error("filesystem mtime must be a non-negative unix-ms integer");
  }
  return integer;
}

function assertContained(root: string, target: string): void {
  const fromRoot = relative(root, target);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error("artifact escapes the configured connector root");
  }
}

/** Read and normalize exactly one artifact without mutating it or its root. */
export async function watchFilesystemArtifact(
  options: WatchFilesystemOptions,
): Promise<FilesystemObservationEnvelope> {
  if (!ROOT_ALIAS.test(options.connectorRoot)) {
    throw new Error("connectorRoot must be a portable logical alias (1-128 characters)");
  }
  const logicalPath = portableRelativePath(options.relativePath);
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 0) {
    throw new Error("maxFileBytes must be a non-negative safe integer");
  }

  const trustedRoot = await realpath(options.rootPath);
  const rootStat = await lstat(trustedRoot);
  if (!rootStat.isDirectory()) throw new Error("configured connector root is not a directory");
  const target = resolve(trustedRoot, ...logicalPath.split("/"));
  assertContained(trustedRoot, target);

  // Reject every symlink component. This is stricter and easier to audit than
  // allowing links that happen to resolve inside the root at one instant.
  let cursor = trustedRoot;
  for (const component of logicalPath.split("/")) {
    cursor = resolve(cursor, component);
    const componentStat = await lstat(cursor);
    if (componentStat.isSymbolicLink()) {
      throw new Error("symlinks are not allowed inside a filesystem connector root");
    }
  }
  assertContained(trustedRoot, await realpath(target));

  const before = await lstat(target);
  let kind: "file" | "directory" | "other" = "other";
  let sizeBytes: number | null = null;
  let contentDigest: string | null = null;

  if (before.isFile()) {
    kind = "file";
    if (before.size > maxFileBytes) {
      throw new Error(`artifact exceeds maxFileBytes (${before.size} > ${maxFileBytes})`);
    }
    const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const openedBefore = await handle.stat();
      if (!openedBefore.isFile() || openedBefore.size > maxFileBytes) {
        throw new Error("artifact changed type or exceeded maxFileBytes while opening");
      }
      const bytes = await handle.readFile();
      const openedAfter = await handle.stat();
      if (
        openedBefore.size !== openedAfter.size ||
        openedBefore.mtimeMs !== openedAfter.mtimeMs ||
        openedBefore.ctimeMs !== openedAfter.ctimeMs
      ) {
        throw new Error("artifact changed while it was being hashed; retry the observation");
      }
      sizeBytes = openedAfter.size;
      contentDigest = sha256(bytes);
    } finally {
      await handle.close();
    }
  } else if (before.isDirectory()) {
    kind = "directory";
  }

  const after = await lstat(target);
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs
  ) {
    throw new Error("artifact changed during observation; retry the observation");
  }

  const occurredAt = safeUnixMs(after.mtimeMs);
  const payload = {
    connectorRoot: options.connectorRoot,
    relativePath: logicalPath,
    kind,
    sizeBytes,
    digest: contentDigest,
  };
  const identityMaterial = JSON.stringify({ contract: 1, payload, occurredAt });
  const factDigest = sha256(identityMaterial);
  const versionId = factDigest.slice("sha256:".length);
  return {
    source: `filesystem-watcher:${options.connectorRoot}`,
    externalEventId: `filesystem-stat-v1-${versionId}`,
    kind: "filesystem.stat",
    payload,
    occurredAt,
    verificationLevel: "authenticated_source",
    verificationMethod: "sandboxed-stat-and-sha256",
    rawRef: `urn:tasq:connector-record:filesystem:${encodeURIComponent(options.connectorRoot)}:${encodeURIComponent(logicalPath)}:${versionId}`,
    digest: factDigest,
    metadata: {
      watcherContract: "tasq.filesystem-stat.v1",
      hashAlgorithm: "sha256",
    },
  };
}
