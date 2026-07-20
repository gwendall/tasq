#!/usr/bin/env node
/** Raw JSON-RPC MCP client: no SDK and no Tasq package imports. */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
const child = spawn(request.serverArgv[0], request.serverArgv.slice(1), {
  env: { ...process.env, ...request.serverEnv },
  stdio: ["pipe", "pipe", "pipe"],
});
let nextId = 1;
const waiting = new Map();
const stderr = [];
child.stderr.on("data", (chunk) => stderr.push(chunk));
createInterface({ input: child.stdout }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id !== undefined && waiting.has(message.id)) {
    const { resolve, reject } = waiting.get(message.id);
    waiting.delete(message.id);
    if (message.error) reject(new Error(JSON.stringify(message.error)));
    else resolve(message.result);
  }
});

function send(method, params, notification = false) {
  const id = notification ? undefined : nextId++;
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method, params }) + "\n");
  if (notification) return Promise.resolve(undefined);
  return new Promise((resolve, reject) => waiting.set(id, { resolve, reject }));
}

try {
  const initialized = await send("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "raw-cold-client", version: "0.0.0" },
  });
  await send("notifications/initialized", {}, true);
  const listed = await send("tools/list", {});
  const calls = [];
  for (const call of request.calls ?? []) {
    calls.push(await send("tools/call", { name: call.name, arguments: call.arguments ?? {} }));
  }
  const selections = [];
  for (const selection of request.selectCalls ?? []) {
    const selector = selection.selector;
    const matches = listed.tools.filter((tool) => {
      const required = [...(tool.inputSchema?.required ?? [])].sort();
      const expectedRequired = [...(selector.requiredInputProperties ?? [])].sort();
      const description = String(tool.description ?? "").toLowerCase();
      return (selector.readOnlyHint === undefined ||
          tool.annotations?.readOnlyHint === selector.readOnlyHint) &&
        JSON.stringify(required) === JSON.stringify(expectedRequired) &&
        (selector.descriptionIncludes ?? []).every((part) =>
          description.includes(String(part).toLowerCase()));
    });
    if (matches.length !== 1) {
      throw new Error(`tool selection matched ${matches.length}, expected one: ${JSON.stringify(selector)}`);
    }
    selections.push(matches[0].name);
    calls.push(await send("tools/call", {
      name: matches[0].name,
      arguments: selection.arguments ?? {},
    }));
  }
  process.stdout.write(JSON.stringify({ initialized, tools: listed.tools, selections, calls }));
} finally {
  child.stdin.end();
  child.kill("SIGTERM");
  if (child.exitCode === null) await new Promise((resolve) => child.once("exit", resolve));
  if (stderr.length > 0 && request.failOnStderr) {
    throw new Error(Buffer.concat(stderr).toString("utf8"));
  }
}
