export type AgentFamily = "codex" | "claude-code" | "opencode";

export interface CommandObservation {
  command: string;
  exitCode: number | null;
}

export interface McpToolObservation {
  server: string;
  tool: string;
  input: unknown;
  succeeded: boolean | null;
}

/** Read only actual shell tool calls from each runtime's event stream. */
export function parseAgentCommands(
  family: AgentFamily,
  transcript: string,
): CommandObservation[] {
  const commands: CommandObservation[] = [];
  for (const line of transcript.split("\n")) {
    if (!line.trim()) continue;
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (family === "codex" && event.type === "item.completed" && event.item?.type === "command_execution") {
      commands.push({ command: String(event.item.command ?? ""), exitCode: Number(event.item.exit_code) });
    }
    if (family === "claude-code" && event.type === "assistant" && Array.isArray(event.message?.content)) {
      for (const item of event.message.content) {
        if (item?.type === "tool_use" && item.name === "Bash" && typeof item.input?.command === "string") {
          commands.push({ command: item.input.command, exitCode: null });
        }
      }
    }
    if (family === "opencode" && event.type === "tool_use" &&
        event.part?.type === "tool" && event.part.tool === "bash" &&
        typeof event.part.state?.input?.command === "string") {
      const exit = event.part.state?.metadata?.exit;
      commands.push({
        command: event.part.state.input.command,
        exitCode: typeof exit === "number" ? exit : null,
      });
    }
  }
  return commands;
}

/** Read actual MCP tool calls without relying on either runtime's final prose. */
export function parseAgentMcpCalls(
  family: AgentFamily,
  transcript: string,
): McpToolObservation[] {
  const calls: McpToolObservation[] = [];
  for (const line of transcript.split("\n")) {
    if (!line.trim()) continue;
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (family === "codex" && event.type === "item.completed" &&
        event.item?.type === "mcp_tool_call") {
      calls.push({
        server: String(event.item.server ?? event.item.server_name ?? ""),
        tool: String(event.item.tool ?? event.item.name ?? ""),
        input: event.item.arguments ?? event.item.input ?? {},
        succeeded: event.item.error ? false : event.item.status === "failed" ? false : true,
      });
    }
    if (family === "claude-code" && event.type === "assistant" &&
        Array.isArray(event.message?.content)) {
      for (const item of event.message.content) {
        if (item?.type !== "tool_use" || typeof item.name !== "string" ||
            !item.name.startsWith("mcp__")) continue;
        const match = item.name.match(/^mcp__([^_]+)__(.+)$/);
        calls.push({
          server: match?.[1] ?? "",
          tool: match?.[2] ?? item.name,
          input: item.input ?? {},
          // Claude's assistant tool-use event precedes its result event. The
          // authoritative state oracle decides success; do not invent it here.
          succeeded: null,
        });
      }
    }
    if (family === "opencode" && event.type === "tool_use" &&
        event.part?.type === "tool" && typeof event.part.tool === "string" &&
        event.part.tool !== "bash" && /(?:^|__)tasq_/.test(event.part.tool)) {
      const match = event.part.tool.match(/^mcp__([^_]+)__(.+)$/);
      calls.push({
        server: match?.[1] ?? "tasq",
        tool: match?.[2] ?? event.part.tool,
        input: event.part.state?.input ?? {},
        succeeded: event.part.state?.status === "error" ? false
          : event.part.state?.status === "completed" ? true : null,
      });
    }
  }
  return calls;
}

/** Strip quoted prose so evidence summaries cannot masquerade as execution. */
export function unquotedShell(command: string): string {
  const singleWrapper = command.match(/^\/bin\/(?:zsh|bash)\s+-(?:l)?c\s+'([\s\S]*)'$/);
  const doubleWrapper = command.match(/^\/bin\/(?:zsh|bash)\s+-(?:l)?c\s+"([\s\S]*)"$/);
  const source = (singleWrapper?.[1] ?? doubleWrapper?.[1] ?? command)
    .split("'\\''").join("'");
  let result = "";
  let quote: "single" | "double" | null = null;
  let escaped = false;
  for (const character of source) {
    if (escaped) {
      if (quote === null) result += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "single") {
      escaped = true;
      continue;
    }
    if (character === "'" && quote !== "double") {
      quote = quote === "single" ? null : "single";
      result += " ";
      continue;
    }
    if (character === '"' && quote !== "single") {
      quote = quote === "double" ? null : "double";
      result += " ";
      continue;
    }
    result += quote === null ? character : character === "\n" ? "\n" : " ";
  }
  return result;
}

/** Resolve shell variables only when this same tool call binds them to a Tasq artifact. */
function resolveTasqExecutableAliases(command: string): string {
  const aliases = new Set<string>();
  const assignment = /(?:^|[;\n]\s*)([A-Za-z_][A-Za-z0-9_]*)=(?:"([^"]+)"|'([^']+)'|([^\s;]+))/gm;
  for (const match of command.matchAll(assignment)) {
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    if (/(?:^|\/)(?:tasq|index\.(?:js|ts))$/.test(value)) aliases.add(match[1]!);
  }
  let resolved = command;
  for (const alias of aliases) {
    for (const reference of [
      `"$${alias}"`, `'$${alias}'`, `$\{${alias}\}`, `$${alias}`,
    ]) resolved = resolved.split(reference).join("tasq");
  }
  return resolved;
}

/** Recognize either the stable `tasq` name or a self-described artifact entrypoint. */
export function executesTasqCommand(command: string, argumentsPattern: string): boolean {
  const singleWrapper = command.match(/^\/bin\/(?:zsh|bash)\s+-(?:l)?c\s+'([\s\S]*)'$/);
  const doubleWrapper = command.match(/^\/bin\/(?:zsh|bash)\s+-(?:l)?c\s+"([\s\S]*)"$/);
  // Agents commonly execute returned argv as individually quoted tokens. Only
  // unquote shell-safe atoms; prose containing spaces stays opaque and cannot
  // masquerade as a command in an evidence/description argument.
  const source = resolveTasqExecutableAliases(singleWrapper?.[1] ?? doubleWrapper?.[1] ?? command)
    .split("'\\''").join("'")
    .replace(/(['"])([A-Za-z0-9._:/-]+)\1/g, "$2");
  const escapedAtom = String.raw`(?:\\.|[^\s;&|"'])*`;
  const executable = String.raw`(?:tasq|${escapedAtom}(?:\/tasq|\/index\.(?:js|ts))|"[^"\n]*(?:\/tasq|\/index\.(?:js|ts))"|'[^'\n]*(?:\/tasq|\/index\.(?:js|ts))')`;
  return new RegExp(
    String.raw`(?:^|[;&|]\s*|\n|\$\()\s*(?:exec\s+)?${executable}\s+${argumentsPattern}(?:\s|$)`,
    "m",
  ).test(source);
}

/** Detect attempts to reinterpret a directly executable Tasq artifact as JS source. */
export function wrapsTasqEntrypointWithRuntime(command: string): boolean {
  const singleWrapper = command.match(/^\/bin\/(?:zsh|bash)\s+-(?:l)?c\s+'([\s\S]*)'$/);
  const doubleWrapper = command.match(/^\/bin\/(?:zsh|bash)\s+-(?:l)?c\s+"([\s\S]*)"$/);
  const source = resolveTasqExecutableAliases(
    singleWrapper?.[1] ?? doubleWrapper?.[1] ?? command,
  ).split("'\\''").join("'");
  const escapedAtom = String.raw`(?:\\.|[^\s;&|"'])*`;
  const tasqEntrypoint = String.raw`(?:tasq|${escapedAtom}(?:\/tasq|\/index\.(?:js|ts))|"[^"\n]*(?:\/tasq|\/index\.(?:js|ts))"|'[^'\n]*(?:\/tasq|\/index\.(?:js|ts))')`;
  return new RegExp(
    String.raw`(?:^|[;&|]\s*|\n)\s*(?:exec\s+)?(?:node|bun)\s+${tasqEntrypoint}(?:\s|$)`,
    "m",
  ).test(source);
}

export function executesResourceVerify(command: string): boolean {
  return executesTasqCommand(command, String.raw`resource\s+verify`);
}

export function executesContextRead(command: string): boolean {
  return executesTasqCommand(command, String.raw`(?:context|brief)`);
}

export function executesCommitmentInspect(command: string): boolean {
  return executesTasqCommand(command, String.raw`inspect`);
}

export function executesSummaryRead(command: string): boolean {
  return executesTasqCommand(command, String.raw`summary\s+(?:current|list|show)`);
}

/** Conservative mutation detector used by read-only semantic trials. */
export function isMutatingTasqCommand(command: string): boolean {
  return executesTasqCommand(command, String.raw`(?:
    add|update|start|done|block|unblock|cancel|reopen|delete|restore|claim|release|
    evidence\s+add|attempt\s+(?:start|status)|resource\s+(?:acquire|renew|release|sweep)|
    summary\s+add|wait\s+(?:add|cancel|supersede)|observation\s+add|reconcile\s+(?:run|sweep)|
    effect\s+(?:propose|approve|deny|revoke|cancel|begin|receipt)|depend|undepend
  )`.replace(/\s+/g, ""));
}

export function mcpToolCalled(calls: readonly McpToolObservation[], tool: string): boolean {
  return calls.some((call) => call.tool === tool || call.tool.endsWith(`__${tool}`));
}

/** Exact marker execution check; quoted ledger prose is intentionally inert. */
export function executesMarker(command: string, marker: string): boolean {
  const executable = unquotedShell(command);
  return executable.includes(marker) && /(?:^|[;&|]\s*|\n)\s*(?:\/usr\/bin\/)?touch(?:\s|$)/m.test(executable);
}

export function isExternalCheckCommand(command: string): boolean {
  return /(?:^|[;&|]\s*|\n)\s*sleep\s+(?:1|180)(?:\D|$)/m.test(unquotedShell(command));
}

export function externalCheckIsVerified(commands: string[]): boolean {
  let latestVerify = -1;
  for (let index = 0; index < commands.length; index += 1) {
    if (executesResourceVerify(commands[index]!)) latestVerify = index;
    if (isExternalCheckCommand(commands[index]!) &&
        latestVerify !== index && latestVerify !== index - 1) return false;
  }
  return true;
}

export function usesRawDeviceClock(command: string): boolean {
  const executable = unquotedShell(command);
  return /(?:^|[;&|]\s*|\n)\s*(?:\/usr\/bin\/)?date(?:\s|$)/m.test(executable) ||
    (/\bpython\d*\b[^\n]*\s-c(?:\s|$)/.test(executable) && /\btime\.(?:time|time_ns)\s*\(/.test(command)) ||
    (/\bnode\b[^\n]*\s-e(?:\s|$)/.test(executable) &&
      /\bDate\.now\s*\(|\bnew\s+Date\s*\(|\bperformance\.now\s*\(/.test(command));
}

export function transcriptShowsContention(transcript: string): boolean {
  return /resource_conflict|contention|not_holder|already held|"status"\s*:\s*"active"|status\s*[=:]\s*`?active`?|current holder/i
    .test(transcript);
}

export function isDomainNeutralDiscovery(discovery: unknown): boolean {
  if (discovery === null || typeof discovery !== "object") return false;
  const extensions = (discovery as { extensions?: unknown }).extensions;
  return Array.isArray(extensions) && extensions.length === 0 &&
    !/(?:gmail|github|mercury|_life)/i.test(JSON.stringify(discovery));
}
