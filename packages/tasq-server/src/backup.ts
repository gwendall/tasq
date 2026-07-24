import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  open,
  readFile,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { digestAuthorityValue } from "@tasq-internal/authority";
import type { Clock } from "@tasq-run/schema";
import { z } from "zod";
import {
  TASQ_SERVER_RUNTIME_VERSION,
} from "./runtime.js";
import type { TasqServerConfig } from "./config.js";

export const TASQ_SERVER_BACKUP_VERSION = "tasq.server-backup.v1" as const;
const Digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const BackupFile = z.object({
  kind: z.enum(["authority", "workspace", "receipts"]),
  workspaceId: z.string().min(1).max(200).nullable(),
  file: z.string().regex(/^[a-zA-Z0-9._-]+\.sqlite$/),
  sha256: Digest,
  bytes: z.number().int().nonnegative(),
}).strict();
export const TasqServerBackupManifest = z.object({
  contractVersion: z.literal(TASQ_SERVER_BACKUP_VERSION),
  serverVersion: z.string().min(1),
  createdAt: z.number().int().nonnegative(),
  configDigest: Digest,
  files: z.array(BackupFile).min(3),
}).strict();
export type TasqServerBackupManifest = z.infer<typeof TasqServerBackupManifest>;

function sqlitePath(url: string): string {
  return fileURLToPath(new URL(url));
}

async function digestFile(path: string): Promise<{ sha256: string; bytes: number }> {
  const content = await readFile(path);
  return {
    sha256: `sha256:${createHash("sha256").update(content).digest("hex")}`,
    bytes: content.byteLength,
  };
}

async function snapshot(sourceUrl: string, destination: string): Promise<void> {
  const client = createClient({ url: sourceUrl });
  try {
    await client.execute("PRAGMA busy_timeout = 30000");
    await client.execute("PRAGMA wal_checkpoint(PASSIVE)");
    await client.execute({ sql: "VACUUM INTO ?", args: [destination] });
    await chmod(destination, 0o600);
  } finally {
    client.close();
  }
}

function files(config: TasqServerConfig): Array<{
  kind: "authority" | "workspace" | "receipts";
  workspaceId: string | null;
  sourceUrl: string;
  file: string;
}> {
  return [
    {
      kind: "authority",
      workspaceId: null,
      sourceUrl: config.authorityDatabaseUrl,
      file: "authority.sqlite",
    },
    ...config.workspaces.flatMap((workspace, index) => [
      {
        kind: "workspace" as const,
        workspaceId: workspace.id,
        sourceUrl: workspace.databaseUrl,
        file: `workspace-${index + 1}.sqlite`,
      },
      {
        kind: "receipts" as const,
        workspaceId: workspace.id,
        sourceUrl: workspace.receiptDatabaseUrl,
        file: `receipts-${index + 1}.sqlite`,
      },
    ]),
  ];
}

export async function backupTasqServer(input: {
  config: TasqServerConfig;
  outputDirectory: string;
  clock: Clock;
}): Promise<TasqServerBackupManifest> {
  const output = resolve(input.outputDirectory);
  await mkdir(output, { mode: 0o700 });
  const handle = await open(join(output, ".incomplete"), "wx", 0o600);
  await handle.close();
  const entries: TasqServerBackupManifest["files"] = [];
  try {
    for (const entry of files(input.config)) {
      const destination = join(output, entry.file);
      await snapshot(entry.sourceUrl, destination);
      const digested = await digestFile(destination);
      entries.push({
        kind: entry.kind,
        workspaceId: entry.workspaceId,
        file: entry.file,
        ...digested,
      });
    }
    const manifest = TasqServerBackupManifest.parse({
      contractVersion: TASQ_SERVER_BACKUP_VERSION,
      serverVersion: TASQ_SERVER_RUNTIME_VERSION,
      createdAt: input.clock.now(),
      configDigest: digestAuthorityValue(input.config),
      files: entries,
    });
    await writeFile(join(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await writeFile(join(output, ".complete"), `${manifest.configDigest}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await unlink(join(output, ".incomplete"));
    return manifest;
  } catch (error) {
    throw new Error(`Tasq Server backup incomplete at ${output}`, { cause: error });
  }
}

export async function restoreTasqServerBackup(input: {
  config: TasqServerConfig;
  backupDirectory: string;
}): Promise<TasqServerBackupManifest> {
  const root = resolve(input.backupDirectory);
  const manifest = TasqServerBackupManifest.parse(JSON.parse(await readFile(join(root, "manifest.json"), "utf8")));
  if (manifest.configDigest !== digestAuthorityValue(input.config)) {
    throw new Error("backup config digest does not match restore config");
  }
  await stat(join(root, ".complete"));
  const destinations = files(input.config);
  if (destinations.length !== manifest.files.length) throw new Error("backup topology does not match restore config");
  for (let index = 0; index < destinations.length; index += 1) {
    const expected = manifest.files[index]!;
    const destination = destinations[index]!;
    if (expected.kind !== destination.kind || expected.workspaceId !== destination.workspaceId
      || expected.file !== destination.file || basename(expected.file) !== expected.file) {
      throw new Error("backup file topology mismatch");
    }
    const source = join(root, expected.file);
    const actual = await digestFile(source);
    if (actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes) {
      throw new Error(`backup checksum mismatch for ${expected.file}`);
    }
    try {
      await stat(sqlitePath(destination.sourceUrl));
      throw new Error(`restore destination already exists: ${sqlitePath(destination.sourceUrl)}`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("restore destination already exists")) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  for (let index = 0; index < destinations.length; index += 1) {
    const expected = manifest.files[index]!;
    const destination = sqlitePath(destinations[index]!.sourceUrl);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await copyFile(join(root, expected.file), destination, constants.COPYFILE_EXCL);
    await chmod(destination, 0o600);
  }
  return manifest;
}
