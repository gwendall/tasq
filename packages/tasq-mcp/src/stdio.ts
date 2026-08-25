#!/usr/bin/env bun

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { openDb, runKernelMigrations, systemClock } from "@tasq-run/core";
import { createTasqMcpServer, parseTasqMcpCapabilities } from "./index.js";

// This is the first thing the published package's README tells a reader to run,
// so it must answer rather than crash. stdout is reserved for MCP JSON-RPC
// frames once the server is connected, but --help never reaches that point.
const USAGE = `tasq-mcp - capability-scoped local Tasq MCP server over stdio

Reads its configuration from the environment; there are no flags.

  TASQ_MCP_WORKSPACE   required   space this server is bound to, e.g. my/project
  TASQ_MCP_ACTOR       required   principal every mutation is attributed to
  TASQ_MCP_CAPABILITIES optional  comma-separated, default read,propose,coordinate
                                  read is required; effect is refused here
  TASQ_MCP_PRINCIPAL_ID optional  explicit principal id
  TASQ_HOME            optional   ledger location, default ~/.tasq

Example:

  TASQ_MCP_WORKSPACE=my/project TASQ_MCP_ACTOR=claude:main tasq-mcp

To register it with a host, prefer: tasq agent install claude --space my/project --actor claude:main
`;

if (process.argv.slice(2).some((arg) => arg === "--help" || arg === "-h")) {
  process.stdout.write(USAGE);
  process.exit(0);
}

// Configuration problems are user errors, not crashes: report them without a
// runtime stack trace, and point at the same usage text.
function configError(message: string): never {
  process.stderr.write(`tasq-mcp: ${message}\n\n${USAGE}`);
  process.exit(1);
}

const workspaceId = process.env.TASQ_MCP_WORKSPACE?.trim();
const actor = process.env.TASQ_MCP_ACTOR?.trim();
if (!workspaceId) configError("TASQ_MCP_WORKSPACE is required");
if (!actor) configError("TASQ_MCP_ACTOR is required");

const capabilities = parseTasqMcpCapabilities(
  process.env.TASQ_MCP_CAPABILITIES ?? "read,propose,coordinate",
);
if (capabilities.includes("effect")) {
  configError("The generic stdio composition root cannot expose effect dispatch authority");
}

const opened = await openDb();
await runKernelMigrations(opened.client, { clock: systemClock });

const server = createTasqMcpServer({
  db: opened.db,
  workspaceId,
  actor,
  principalId: process.env.TASQ_MCP_PRINCIPAL_ID?.trim() || undefined,
  capabilities,
  clock: systemClock,
});

let closing = false;
async function close(): Promise<void> {
  if (closing) return;
  closing = true;
  await server.close();
  await opened.close();
}

process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());

try {
  await server.connect(new StdioServerTransport());
} catch (error) {
  await opened.close();
  // stdout is reserved for MCP JSON-RPC frames.
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
