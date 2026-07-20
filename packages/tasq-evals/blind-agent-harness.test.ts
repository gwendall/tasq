import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  executesTasqCommand,
  executesCommitmentInspect,
  executesContextRead,
  executesMarker,
  executesSummaryRead,
  externalCheckIsVerified,
  isDomainNeutralDiscovery,
  isExternalCheckCommand,
  isMutatingTasqCommand,
  mcpToolCalled,
  parseAgentCommands,
  parseAgentMcpCalls,
  transcriptShowsContention,
  unquotedShell,
  usesRawDeviceClock,
  wrapsTasqEntrypointWithRuntime,
} from "./src/blind-agent-observer.js";

describe("TQ-315 blind-agent harness", () => {
  test("normalizes Codex, Claude Code and OpenCode tool calls without trusting final prose", () => {
    const codex = JSON.stringify({
      type: "item.completed",
      item: { type: "command_execution", command: "tasq onboard --space s --actor a --json", exit_code: 0 },
    });
    const claude = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Bash", input: { command: "tasq resource list --json" } }] },
    });
    expect(parseAgentCommands("codex", codex)).toEqual([
      { command: "tasq onboard --space s --actor a --json", exitCode: 0 },
    ]);
    expect(parseAgentCommands("claude-code", claude)).toEqual([
      { command: "tasq resource list --json", exitCode: null },
    ]);
    const opencode = JSON.stringify({
      type: "tool_use",
      part: {
        type: "tool", tool: "bash",
        state: { status: "completed", input: { command: "tasq context --json" }, metadata: { exit: 0 } },
      },
    });
    expect(parseAgentCommands("opencode", opencode)).toEqual([
      { command: "tasq context --json", exitCode: 0 },
    ]);
    expect(parseAgentCommands("codex", JSON.stringify({ type: "agent_message", text: "I succeeded" }))).toEqual([]);
  });

  test("normalizes MCP calls and semantic read/mutation evidence across runtimes", () => {
    const codex = JSON.stringify({
      type: "item.completed",
      item: {
        type: "mcp_tool_call", server: "tasq", tool: "tasq_context",
        arguments: { maxRecords: 5 }, status: "completed",
      },
    });
    const claude = JSON.stringify({
      type: "assistant",
      message: { content: [{
        type: "tool_use", name: "mcp__tasq__tasq_resource_get", input: { resourceKey: "port/1" },
      }] },
    });
    const calls = [
      ...parseAgentMcpCalls("codex", codex),
      ...parseAgentMcpCalls("claude-code", claude),
      ...parseAgentMcpCalls("opencode", JSON.stringify({
        type: "tool_use",
        part: {
          type: "tool", tool: "mcp__tasq__tasq_context",
          state: { status: "completed", input: { maxRecords: 5 } },
        },
      })),
    ];
    expect(calls).toEqual([
      { server: "tasq", tool: "tasq_context", input: { maxRecords: 5 }, succeeded: true },
      { server: "tasq", tool: "tasq_resource_get", input: { resourceKey: "port/1" }, succeeded: null },
      { server: "tasq", tool: "tasq_context", input: { maxRecords: 5 }, succeeded: true },
    ]);
    expect(mcpToolCalled(calls, "tasq_context")).toBe(true);
    expect(mcpToolCalled(calls, "tasq_resource_get")).toBe(true);

    expect(executesContextRead("tasq context --json")).toBe(true);
    expect(executesCommitmentInspect("tasq inspect abc --json")).toBe(true);
    expect(executesSummaryRead("tasq summary current --json")).toBe(true);
    expect(executesSummaryRead(`/bin/zsh -lc "'tasq' 'summary' 'current' '--json'"`)).toBe(true);
    expect(executesSummaryRead(
      `/bin/zsh -c '"tasq" "summary" "list" "abc" "--json"'`,
    )).toBe(true);
    const aliased = 'TQ="/tmp/release with spaces/index.js"; "$TQ" summary list abc --json';
    expect(executesSummaryRead(aliased)).toBe(true);
    expect(executesTasqCommand(
      String.raw`/tmp/release\ with\ spaces/tasq list --json`,
      String.raw`list`,
    )).toBe(true);
    expect(executesContextRead(
      `/bin/zsh -lc "exec '/tmp/release/index.js' 'context' '--json'"`,
    )).toBe(true);
    expect(executesCommitmentInspect(
      'TQ=/tmp/release/index.js; T=space; "$TQ" inspect abc --tenant $T --json',
    )).toBe(true);
    expect(externalCheckIsVerified([
      `/bin/zsh -lc "'tasq' 'resource' 'verify' 'port/1' '--json' && sleep 1"`,
    ])).toBe(true);
    expect(isMutatingTasqCommand("tasq resource acquire port/1 --json")).toBe(true);
    expect(isMutatingTasqCommand("tasq context --json")).toBe(false);
    expect(executesMarker("tasq add 'touch /tmp/marker' --json", "/tmp/marker")).toBe(false);
    expect(executesMarker("/usr/bin/touch /tmp/marker", "/tmp/marker")).toBe(true);
  });

  test("does not mistake task/evidence prose for external work", () => {
    const commands = [
      "tasq add 'Run sleep 1 safely' --json",
      "tasq resource acquire key --json",
      "tasq resource verify key --json",
      "sleep 1",
      "tasq evidence add id --summary 'sleep 1 passed' --json",
    ];
    expect(commands.map(isExternalCheckCommand)).toEqual([false, false, false, true, false]);
    expect(externalCheckIsVerified(commands)).toBe(true);
    expect(externalCheckIsVerified(["tasq add 'sleep 1'", "sleep 1", "tasq resource verify key"]))
      .toBe(false);
    expect(externalCheckIsVerified(["V=$(tasq resource verify key --json)\nsleep 1"]))
      .toBe(true);
    expect(executesTasqCommand(
      "'/tmp/release with spaces/index.js' resource list --json",
      String.raw`resource\s+(?:get|list)`,
    )).toBe(true);
    expect(externalCheckIsVerified([
      "\"/tmp/release with spaces/index.js\" resource verify key --json",
      "sleep 1",
    ])).toBe(true);
    expect(externalCheckIsVerified([
      'TQ="/tmp/release/index.js"; "$TQ" resource verify key --json',
      "sleep 1",
    ])).toBe(true);
    expect(externalCheckIsVerified([
      "tasq resource verify key --json", "tasq resource get key --json", "sleep 1",
    ])).toBe(false);
    expect(externalCheckIsVerified([
      "tasq resource verify key --json", "tasq resource verify key --json", "sleep 1",
    ])).toBe(true);
    expect(externalCheckIsVerified([
      "tasq resource verify key --json && if false; then sleep 1; fi",
      "tasq resource get key --json",
      "sleep 1",
    ])).toBe(false);
    expect(isExternalCheckCommand("tasq resource verify key --json && sleep 180")).toBe(true);
    expect(isExternalCheckCommand("/bin/zsh -lc 'tasq resource verify key --json && sleep 1'"))
      .toBe(true);
    expect(isExternalCheckCommand("/bin/zsh -c 'sleep 1'")).toBe(true);
    expect(isExternalCheckCommand(
      'tasq evidence add id --summary "tasq resource verify key ran; sleep 1 was NEVER executed"',
    )).toBe(false);
    expect(unquotedShell('tasq add "Run sleep 1" && sleep 1')).toContain("&& sleep 1");
  });

  test("rejects device time reads without confusing authority timestamps in evidence", () => {
    expect(usesRawDeviceClock("date -u +%s && sleep 1")).toBe(true);
    expect(usesRawDeviceClock("python3 -c 'import time; print(time.time_ns())'")).toBe(true);
    expect(usesRawDeviceClock("node -e 'console.log(Date.now())'")).toBe(true);
    expect(usesRawDeviceClock("tasq evidence add id --summary 'authority observedAt 123' --json")).toBe(false);
  });

  test("rejects node or bun wrappers around a directly executable Tasq entrypoint", () => {
    expect(wrapsTasqEntrypointWithRuntime('node "/tmp/release/index.js" context --json'))
      .toBe(true);
    expect(wrapsTasqEntrypointWithRuntime(
      'CLI=/tmp/release/index.js; node "$CLI" resource list --json',
    )).toBe(true);
    expect(wrapsTasqEntrypointWithRuntime(
      'T="/tmp/release with spaces/tasq"\n bun "$T" context --json',
    )).toBe(true);
    expect(wrapsTasqEntrypointWithRuntime(
      String.raw`node /tmp/release\ with\ spaces/index.js context --json`,
    )).toBe(true);
    expect(wrapsTasqEntrypointWithRuntime(
      `exec node '/tmp/release/index.js' context --json`,
    )).toBe(true);
    expect(wrapsTasqEntrypointWithRuntime('"/tmp/release/index.js" context --json'))
      .toBe(false);
    expect(wrapsTasqEntrypointWithRuntime('tasq context --json')).toBe(false);
  });

  test("recognizes structured and shell-summarized contention evidence", () => {
    const summarized = JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", content: "not_holder | holder=peer | status=active" }] },
    });
    expect(transcriptShowsContention(summarized)).toBe(true);
    expect(transcriptShowsContention('{"status": "active", "holderActor": "peer"}')).toBe(true);
    expect(transcriptShowsContention("authority-observed contention; status: `active`")).toBe(true);
    expect(transcriptShowsContention("resource is released")).toBe(false);
  });

  test("fails closed when immutable discovery proof is absent or provider-contaminated", () => {
    expect(isDomainNeutralDiscovery({ contractVersion: "tasq.discovery.v1", extensions: [] })).toBe(true);
    expect(isDomainNeutralDiscovery(undefined)).toBe(false);
    expect(isDomainNeutralDiscovery({ extensions: [{ name: "Mercury" }] })).toBe(false);
    expect(isDomainNeutralDiscovery({ extensions: [], hint: "gmail" })).toBe(false);
  });

  test("uses monotonic harness duration and leaves authority time to injected Tasq composition", async () => {
    const source = await readFile(resolve(import.meta.dir, "../../scripts/run-blind-agent-trials.ts"), "utf8");
    expect(source).toContain("Bun.nanoseconds()");
    expect(source).not.toMatch(/Date\.now\s*\(/);
    expect(source).not.toMatch(/new\s+Date\s*\(/);
    expect(source).not.toMatch(/performance\.now\s*\(/);
    expect(source).toContain("noImplicitDomainProvisioning");
    expect(source).toContain("domainNeutralDiscovery");
    expect(source).toContain("agent workspace é (cold)");
    expect(source).toContain("tasq blind level c é-");
  });
});
