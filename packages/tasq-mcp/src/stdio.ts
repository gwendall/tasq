#!/usr/bin/env bun

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { openDb, runKernelMigrations, systemClock } from "@tasq/core";
import { createTasqMcpServer, parseTasqMcpCapabilities } from "./index.js";

const workspaceId = process.env.TASQ_MCP_WORKSPACE?.trim();
const actor = process.env.TASQ_MCP_ACTOR?.trim();
if (!workspaceId) throw new Error("TASQ_MCP_WORKSPACE is required");
if (!actor) throw new Error("TASQ_MCP_ACTOR is required");

const capabilities = parseTasqMcpCapabilities(
  process.env.TASQ_MCP_CAPABILITIES ?? "read,propose,coordinate",
);
if (capabilities.includes("effect")) {
  throw new Error("The generic stdio composition root cannot expose effect dispatch authority");
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
