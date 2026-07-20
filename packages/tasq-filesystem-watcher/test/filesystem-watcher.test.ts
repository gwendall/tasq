import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watchFilesystemArtifact } from "../src/index.js";

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function fixture(): { root: string; file: string; bytes: string } {
  const root = mkdtempSync(join(tmpdir(), "tasq-filesystem-watcher-"));
  tmpDirs.push(root);
  mkdirSync(join(root, "nested"));
  const file = join(root, "nested", "artifact.txt");
  const bytes = "private body that must never enter the normalized fact\n";
  writeFileSync(file, bytes);
  utimesSync(file, 1_780_000_000, 1_780_000_000);
  return { root, file, bytes };
}

describe("read-only filesystem watcher", () => {
  it("emits a deterministic, bounded envelope without path or content leakage", async () => {
    const { root, file, bytes } = fixture();
    const input = { connectorRoot: "test-root", rootPath: root, relativePath: "nested/artifact.txt" };
    const first = await watchFilesystemArtifact(input);
    const second = await watchFilesystemArtifact(input);

    expect(second).toEqual(first);
    expect(first).toMatchObject({
      source: "filesystem-watcher:test-root",
      kind: "filesystem.stat",
      payload: {
        connectorRoot: "test-root",
        relativePath: "nested/artifact.txt",
        kind: "file",
        sizeBytes: Buffer.byteLength(bytes),
        digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      },
      occurredAt: 1_780_000_000_000,
      verificationLevel: "authenticated_source",
      verificationMethod: "sandboxed-stat-and-sha256",
    });
    expect(first.externalEventId).toMatch(/^filesystem-stat-v1-[a-f0-9]{64}$/);
    const serialized = JSON.stringify(first);
    expect(serialized).not.toContain(root);
    expect(serialized).not.toContain(file);
    expect(serialized).not.toContain(bytes.trim());
    expect(readFileSync(file, "utf8")).toBe(bytes);
  });

  it("rejects traversal, symlinks, invalid aliases and oversized files", async () => {
    const { root, file } = fixture();
    symlinkSync(file, join(root, "nested", "link.txt"));
    await expect(watchFilesystemArtifact({
      connectorRoot: "test-root", rootPath: root, relativePath: "../outside.txt",
    })).rejects.toThrow(/relative path|escapes/);
    await expect(watchFilesystemArtifact({
      connectorRoot: "test-root", rootPath: root, relativePath: "nested/../nested/artifact.txt",
    })).rejects.toThrow(/portable relative path/);
    await expect(watchFilesystemArtifact({
      connectorRoot: "test-root", rootPath: root, relativePath: "nested/link.txt",
    })).rejects.toThrow(/symlinks/);
    await expect(watchFilesystemArtifact({
      connectorRoot: "bad alias", rootPath: root, relativePath: "nested/artifact.txt",
    })).rejects.toThrow(/logical alias/);
    await expect(watchFilesystemArtifact({
      connectorRoot: "test-root", rootPath: root, relativePath: "nested/artifact.txt", maxFileBytes: 1,
    })).rejects.toThrow(/maxFileBytes/);
  });

  it("offers a JSON-only, manually invokable CLI", () => {
    const { root, bytes } = fixture();
    const cli = join(import.meta.dir, "../src/cli.ts");
    const result = Bun.spawnSync([
      process.execPath,
      "run",
      cli,
      "--root-alias", "cli-root",
      "--root", root,
      "--path", "nested/artifact.txt",
    ]);
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(result.stderr.toString()).toBe("");
    const output = JSON.parse(result.stdout.toString()) as Record<string, unknown>;
    expect(output.source).toBe("filesystem-watcher:cli-root");
    expect(JSON.stringify(output)).not.toContain(bytes.trim());
    expect(JSON.stringify(output)).not.toContain(root);
  });
});
