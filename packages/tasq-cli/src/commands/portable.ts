import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import {
  exportPortableStore,
  importPortableStore,
  type PortableExportDocument,
} from "@tasq-internal/local-service";
import type { Clock } from "@tasq-run/schema";
import type { ParsedArgs } from "../args.js";
import { configDir } from "../config.js";
import { openRuntime } from "../runtime.js";
import { printInfo, printJson } from "../output/format.js";

export async function portableExportCmd(args: ParsedArgs, clock: Clock): Promise<number> {
  const runtime = await openRuntime(args.string("actor"), args.string("tenant"), clock);
  try {
    const result = await exportPortableStore(runtime.client, runtime.config.tenantId, {
      now: clock.now(),
      maxRecords: args.number("max-records"),
      maxBytes: args.number("max-bytes"),
    });
    const target = resolve(args.positional[0] ?? defaultExportPath(runtime.config.tenantId, result.document.exportedAt));
    if (existsSync(target)) throw new Error(`Portable export target already exists: ${target}`);
    writePrivateAtomic(target, `${JSON.stringify(result.document, null, 2)}\n`);
    const output = {
      contractVersion: "tasq.portable-export-result.v1",
      ok: true,
      target,
      workspaceId: result.document.workspaceId,
      storeFormat: result.document.storeFormat,
      recordCount: result.recordCount,
      sizeBytes: result.sizeBytes,
      sha256: result.sha256,
      omissions: result.document.omissions,
      import: { argv: ["tasq", "import", target, "--db", "<new-db-path>", "--json"] },
    };
    if (args.bool("json", "j")) printJson(output);
    else {
      printInfo(`Portable export written to ${target}`);
      printInfo(`  records: ${result.recordCount}`);
      printInfo(`  sha256: ${result.sha256}`);
    }
    return 0;
  } finally {
    await runtime.close();
  }
}

export async function portableImportCmd(args: ParsedArgs, clock: Clock): Promise<number> {
  const source = args.positional[0];
  const target = args.string("db");
  if (!source) throw new Error("Usage: tasq import <export.json> --db <new-db-path> [--json]");
  if (!target) throw new Error("Portable import requires --db <new-db-path>");
  const absoluteSource = resolve(source);
  const size = statSync(absoluteSource).size;
  if (size > 512 * 1024 * 1024) throw new Error("Portable import exceeds the 512 MiB input limit");
  const bytes = readFileSync(absoluteSource);
  const digest = createHash("sha256").update(bytes).digest("hex");
  let document: PortableExportDocument;
  try {
    document = JSON.parse(bytes.toString("utf8")) as PortableExportDocument;
  } catch {
    throw new Error("Portable import is not valid JSON");
  }
  const result = await importPortableStore(document, target, digest, clock.now());
  const output = {
    contractVersion: "tasq.portable-import-result.v1",
    ok: true,
    ...result,
    next: {
      doctor: ["env", `TASQ_DB_URL=file:${result.target}`, "tasq", "doctor", "--tenant", result.workspaceId, "--actor", "<stable-label>", "--json"],
      use: ["env", `TASQ_DB_URL=file:${result.target}`, "tasq", "onboard", "--space", result.workspaceId, "--actor", "<stable-label>", "--json"],
    },
  };
  if (args.bool("json", "j")) printJson(output);
  else {
    printInfo(`Portable import created ${result.target}`);
    printInfo(`  workspace: ${result.workspaceId}`);
    printInfo(`  records: ${result.recordCount}`);
  }
  return 0;
}

function defaultExportPath(workspaceId: string, now: number): string {
  const workspace = createHash("sha256").update(workspaceId).digest("hex").slice(0, 12);
  const timestamp = new Date(now).toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 23);
  return join(configDir(), "exports", `tasq-${workspace}-${timestamp}.json`);
}

function writePrivateAtomic(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, contents, { encoding: "utf8", mode: 0o600 });
  chmodSync(temporary, 0o600);
  const descriptor = openSync(temporary, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, path);
}
