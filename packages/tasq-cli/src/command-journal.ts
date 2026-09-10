/**
 * `~/.tasq/commands.jsonl` — one private local line per invocation.
 *
 * The ledger records what SUCCEEDS: every mutation leaves an event. It records
 * almost nothing about what fails, and nothing at all about reads. `next`,
 * `why` and `onboard` leave no trace, so `tasq usage` has to report them as
 * unobservable rather than as zero, and a refusal left only `last-failure.json`
 * — a single slot, overwritten by the next failure, carrying no message.
 *
 * Two real defects found on 2026-09-09 (`attempt succeed <task-id>` refusing a
 * task id, `capture` refusing every commitment carrying a planning scope) were
 * invisible in the ledger for exactly this reason: both are refusals, and a
 * refusal is the signal that says the product does not fit the hand using it.
 * Rolling Tasq out to other projects to collect feedback without this is
 * collecting the half of the story that already works.
 *
 * Privacy: this file never leaves the machine on its own. It records the SHAPE
 * of a command — verb, subcommand, flag NAMES — never positional values or flag
 * values, exactly as `tasq feedback` does. It additionally keeps a truncated
 * error message, because "capture failed 40 times" without the reason cannot be
 * acted on; `tasq feedback push` still publishes only what an operator reviews.
 */
import { closeSync, constants, existsSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { arch, platform } from "node:process";
import { z } from "zod";
import { configDir } from "./config.js";

export const COMMAND_RECORD_CONTRACT = "tasq.command-record.v1" as const;
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_RECORDS = 20_000;
/** Keep the most recent 75% when the bound is reached: old shape ages out first. */
const KEEP_ON_ROTATE = 0.75;
const MAX_MESSAGE = 200;
/** Identifiers are noise in a refusal, and the likeliest thing to name content. */
const IDENTIFIER = /\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b|\b[0-9a-f]{12,}\b/gi;

/**
 * `attempt not found: <id>` is exactly as actionable as the same line carrying
 * the id, so the id is dropped: what a report needs is the SHAPE of the
 * refusal, and an identifier is the part most likely to name someone's work.
 */
export function redactMessage(message: string): string {
  return message.replace(IDENTIFIER, "<id>").slice(0, MAX_MESSAGE);
}

export const CommandRecord = z.object({
  contractVersion: z.literal(COMMAND_RECORD_CONTRACT),
  recordedAt: z.number().int().nonnegative(),
  version: z.string(),
  platform: z.string(),
  architecture: z.string(),
  /** Which agent harness ran it, when the environment names one. */
  harness: z.string(),
  space: z.string().nullable(),
  actor: z.string().nullable(),
  command: z.string(),
  subcommand: z.string().nullable(),
  flags: z.array(z.string()),
  exitCode: z.number().int().min(0).max(255),
  /** The typed problem code when the CLI classified one. */
  code: z.string().nullable(),
  message: z.string().nullable(),
  durationMs: z.number().int().nonnegative(),
}).strict();
export type CommandRecordT = z.infer<typeof CommandRecord>;

/**
 * Agent harnesses announce themselves in the environment. Reading the name lets
 * a rollout answer "does Codex trip over what Claude Code sails through", which
 * an actor label cannot: an actor is chosen by whoever typed the setup command.
 */
export function detectHarness(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT) return "claude-code";
  if (env.CODEX_SANDBOX || env.CODEX_HOME || env.CODEX_CLI) return "codex";
  if (env.CURSOR_TRACE_ID || env.CURSOR_AGENT) return "cursor";
  if (env.AIDER_MODEL) return "aider";
  if (env.GITHUB_ACTIONS) return "github-actions";
  if (env.TERM_PROGRAM) return `terminal:${env.TERM_PROGRAM}`;
  return "unknown";
}

/**
 * Verb, subcommand and flag NAMES, and nothing else.
 *
 * Reuses `tasq feedback`'s allowlist rather than taking the first bare token as
 * a subcommand: `capture <task-id> "<text>"` would otherwise record the task
 * id, and a task id is a positional value the offline-feedback contract
 * (TQ-636) says is never stored.
 */
export { safeCommandShape as commandShape } from "./commands/feedback.js";

function journalPath(): string {
  return join(configDir(), "commands.jsonl");
}

/**
 * A private home is a precondition, never something this creates: cold
 * validation must stay zero-mutation, so an invocation before `tasq setup`
 * leaves nothing behind.
 */
function usableHome(): string | null {
  const home = configDir();
  if (!existsSync(home)) return null;
  const info = lstatSync(home);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) return null;
  return home;
}

function rotate(path: string): void {
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  const kept = lines.slice(Math.floor(lines.length * (1 - KEEP_ON_ROTATE)));
  const temporary = `${path}.${process.pid}.rotate.tmp`;
  try {
    writeFileSync(temporary, `${kept.join("\n")}\n`, { encoding: "utf8", mode: 0o600, flag: "w" });
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

export function recordCommand(input: Omit<CommandRecordT, "contractVersion" | "platform" | "architecture" | "harness">): void {
  const home = usableHome();
  if (home === null) return;
  const record = CommandRecord.parse({
    contractVersion: COMMAND_RECORD_CONTRACT,
    platform,
    architecture: arch,
    harness: detectHarness(),
    ...input,
    message: input.message === null ? null : redactMessage(input.message),
  });
  const path = join(home, "commands.jsonl");
  const line = `${JSON.stringify(record)}\n`;
  if (existsSync(path)) {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) return;
    if (info.size + Buffer.byteLength(line) > MAX_BYTES) rotate(path);
  }
  const fd = openSync(path, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    writeSync(fd, line, undefined, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Every well-formed record, oldest first. A corrupt line is skipped, never fatal. */
export function readCommandJournal(sinceMs = 0): CommandRecordT[] {
  const path = journalPath();
  if (!existsSync(path)) return [];
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_BYTES * 2) return [];
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean).slice(-MAX_RECORDS);
  const records: CommandRecordT[] = [];
  for (const line of lines) {
    try {
      const parsed = CommandRecord.safeParse(JSON.parse(line));
      if (parsed.success && parsed.data.recordedAt >= sinceMs) records.push(parsed.data);
    } catch {
      // A truncated tail from a killed process must not blind the whole report.
    }
  }
  return records;
}

export { journalPath as commandJournalPath };
