#!/usr/bin/env bun

import { watchFilesystemArtifact } from "./index.js";

interface CliArgs {
  connectorRoot: string;
  rootPath: string;
  relativePath: string;
  maxFileBytes?: number;
}

function usage(): string {
  return "usage: tasq-watch-filesystem --root-alias <alias> --root <directory> --path <relative-path> [--max-file-bytes <bytes>]";
}

export function parseFilesystemWatcherArgs(argv: string[]): CliArgs {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value == null || value.startsWith("--")) {
      throw new Error(usage());
    }
    if (values.has(flag)) throw new Error(`duplicate option: ${flag}`);
    values.set(flag, value);
  }
  const allowed = new Set(["--root-alias", "--root", "--path", "--max-file-bytes"]);
  for (const flag of values.keys()) {
    if (!allowed.has(flag)) throw new Error(`unknown option: ${flag}`);
  }
  const connectorRoot = values.get("--root-alias");
  const rootPath = values.get("--root");
  const relativePath = values.get("--path");
  if (!connectorRoot || !rootPath || !relativePath) throw new Error(usage());
  const rawMax = values.get("--max-file-bytes");
  const maxFileBytes = rawMax == null ? undefined : Number(rawMax);
  return { connectorRoot, rootPath, relativePath, maxFileBytes };
}

export async function runFilesystemWatcherCli(argv: string[]): Promise<void> {
  const observation = await watchFilesystemArtifact(parseFilesystemWatcherArgs(argv));
  process.stdout.write(`${JSON.stringify(observation)}\n`);
}

if (import.meta.main) {
  try {
    await runFilesystemWatcherCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
