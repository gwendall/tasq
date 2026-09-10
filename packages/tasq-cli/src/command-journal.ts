/**
 * `~/.tasq/commands.jsonl` - one private local line per invocation.
 *
 * The ledger records what SUCCEEDS: every mutation leaves an event. It records
 * almost nothing about what fails, and nothing at all about reads. `next`,
 * `why` and `onboard` leave no trace, so `tasq usage` has to report them as
 * unobservable rather than as zero, and a refusal left only `last-failure.json`
 * - a single slot, overwritten by the next failure, carrying no message.
 *
 * Two real defects found on 2026-09-09 (`attempt succeed <task-id>` refusing a
 * task id, `capture` refusing every commitment carrying a planning scope) were
 * invisible in the ledger for exactly this reason: both are refusals, and a
 * refusal is the signal that says the product does not fit the hand using it.
 * Rolling Tasq out to other projects to collect feedback without this is
 * collecting the half of the story that already works.
 *
 * Privacy: this file never leaves the machine on its own. It records the SHAPE
 * of a command - verb, subcommand, flag NAMES - never positional values or flag
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
 * Only the authored prefix of a refusal, never the value it quotes back.
 *
 * Roughly eighty error strings in this CLI interpolate what the user typed:
 * `--metadata must be valid JSON, got: <the raw value>`, `Invalid date:
 * <value>`, `Unknown flag: <name>`. Storing the whole line put a secret pasted
 * into `--metadata` in a file, and `tasq usage` printed it back. Every one of
 * those strings interpolates AFTER a `: ` or inside quotes, and the part before
 * is the authored shape - which is the only part a report can act on.
 *
 * `attempt not found: <id>` is exactly as actionable as `attempt not found`,
 * and an identifier is the part most likely to name someone's work.
 */
export function redactMessage(message: string): string {
  // A refusal that prints a usage banner is many lines long, and `tasq usage`
  // reprints what is stored here inside an indented column. Storing the banner
  // whole turned the report into a wall of argument syntax with the counts
  // lost inside it. Only the first line is the refusal; the rest is help.
  const firstLine = message.split("\n", 1)[0]!.replace(/\s+/g, " ");
  const valueStarts = firstLine.search(/:\s|["'`]/);
  const shape = valueStarts === -1 ? firstLine : firstLine.slice(0, valueStarts);
  return shape.replace(IDENTIFIER, "<id>").trim().slice(0, MAX_MESSAGE);
}

const CommandRecordShape = z.object({
  contractVersion: z.literal(COMMAND_RECORD_CONTRACT),
  recordedAt: z.number().int().nonnegative(),
  version: z.string(),
  platform: z.string(),
  architecture: z.string(),
  /** Which agent harness ran it, when the environment names one. */
  harness: z.string(),
  space: z.string().nullable(),
  command: z.string(),
  subcommand: z.string().nullable(),
  flags: z.array(z.string()),
  exitCode: z.number().int().min(0).max(255),
  /** The typed problem code when the CLI classified one. */
  code: z.string().nullable(),
  message: z.string().nullable(),
  durationMs: z.number().int().nonnegative(),
});
/**
 * Written strictly, read leniently.
 *
 * Writing rejects any field this version did not mean to store, which is the
 * privacy guard. Reading must not: a record written by a NEWER Tasq carries a
 * field this one has never heard of, and a strict read rejected the whole
 * line. Every record then failed, and `tasq usage` reported "no command
 * journal yet" - the one answer that reads as "nothing happened" instead of
 * "these are newer than me". An unknown field is dropped and the record kept.
 */
export const CommandRecord = CommandRecordShape.strict();
export type CommandRecordT = z.infer<typeof CommandRecordShape>;

/**
 * Agent harnesses announce themselves in the environment. Reading the name lets
 * a rollout answer "does Codex trip over what Claude Code sails through", which
 * an actor label cannot: an actor is chosen by whoever typed the setup command.
 * The label itself is never recorded. It is content a person wrote, it often
 * carries their name, and no report reads it - and recording it only when it
 * arrived through TASQ_ACTOR, while dropping the identical label passed as
 * `--actor`, was one rule applied two ways.
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

/**
 * Trim the journal to its most recent records, at most one process at a time.
 *
 * Rotation reads the whole file and renames a rewritten copy over it, so two
 * agents working the same machine could both read, both rewrite, and the second
 * rename would drop whatever the first had appended. The exclusive lock file is
 * the whole guard: a process that cannot take it skips rotating, the journal
 * stays a few lines over its bound for one more invocation, and nothing is
 * lost. Instrumentation is never worth losing a record over.
 *
 * The lock carries the holder's pid, and a lock whose process is gone is
 * reclaimed, so a killed writer cannot wedge rotation forever. The liveness
 * check is deliberately not a timeout: an expiry needs a clock, and only
 * `systemClock` may read the host clock.
 */
function rotate(path: string, ownPid: number): void {
  const lock = `${path}.rotate.lock`;
  try {
    const holder = Number(readFileSync(lock, "utf8").trim());
    // Signal 0 tests for existence without delivering anything. EPERM means the
    // process is alive and owned by somebody else, which still counts as held.
    if (Number.isInteger(holder) && holder > 0) process.kill(holder, 0);
    else unlinkSync(lock);
  } catch (error) {
    // ENOENT: no lock, take it below. ESRCH: the holder died, reclaim it.
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") {
      try {
        unlinkSync(lock);
      } catch {
        // Another process reclaimed the same dead lock first: it wins.
      }
    } else if (code !== "ENOENT") {
      return; // held, or unreadable: skip rotating rather than risk the file
    }
  }
  let fd: number;
  try {
    fd = openSync(lock, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  } catch {
    return; // another process is rotating; this record still appends below
  }
  writeSync(fd, `${ownPid}\n`, undefined, "utf8");
  closeSync(fd);
  const temporary = `${path}.${process.pid}.rotate.tmp`;
  try {
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    const kept = lines.slice(Math.floor(lines.length * (1 - KEEP_ON_ROTATE)));
    writeFileSync(temporary, `${kept.join("\n")}\n`, { encoding: "utf8", mode: 0o600, flag: "w" });
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
    if (existsSync(lock)) unlinkSync(lock);
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
    if (info.size + Buffer.byteLength(line) > MAX_BYTES) rotate(path, process.pid);
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
  let lines: string[];
  try {
    const path = journalPath();
    if (!existsSync(path)) return [];
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_BYTES * 2) return [];
    lines = readFileSync(path, "utf8").split("\n").filter(Boolean).slice(-MAX_RECORDS);
  } catch {
    // An unreadable journal is a report with less in it, never a failed
    // `tasq usage`: `chmod 000` on this file used to take the command down
    // with a raw EACCES, which is the opposite of what instrumentation owes.
    return [];
  }
  const records: CommandRecordT[] = [];
  for (const line of lines) {
    try {
      const parsed = CommandRecordShape.safeParse(JSON.parse(line));
      if (parsed.success && parsed.data.recordedAt >= sinceMs) records.push(parsed.data);
    } catch {
      // A truncated tail from a killed process must not blind the whole report.
    }
  }
  return records;
}

export { journalPath as commandJournalPath };
