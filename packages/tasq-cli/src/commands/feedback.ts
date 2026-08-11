import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { platform, arch } from "node:process";
import {
  parseGitHubRepositoryName,
  publishGitHubFeedbackIssue,
  type GitHubFeedbackReport,
} from "@tasq-internal/github-bridge";
import type { Clock } from "@tasq-run/schema";
import { z } from "zod";
import type { ParsedArgs } from "../args.js";
import { configDir } from "../config.js";
import { printInfo, printJson } from "../output/format.js";

const MAX_STORE_BYTES = 10 * 1024 * 1024;
const MAX_EVENTS = 10_000;
const Capture = z.object({
  contractVersion: z.literal("tasq.feedback-captured.v1"),
  type: z.literal("captured"),
  id: z.string().uuid(),
  summary: z.string().min(1).max(500),
  details: z.string().min(1).max(10_000).nullable(),
  capturedAt: z.number().int().nonnegative(),
  context: z.object({
    version: z.string(),
    platform: z.string(),
    architecture: z.string(),
    previousFailure: z.object({
      command: z.string(),
      subcommand: z.string().nullable(),
      flags: z.array(z.string()),
      exitCode: z.number().int(),
      recordedAt: z.number().int().nonnegative(),
    }).strict().nullable(),
  }).strict(),
}).strict();
const Publication = z.object({
  contractVersion: z.literal("tasq.feedback-published.v1"),
  type: z.literal("published"),
  id: z.string().uuid(),
  repository: z.string(),
  issueNumber: z.number().int().positive(),
  issueUrl: z.string().url(),
  disposition: z.enum(["created", "existing"]),
  publishedAt: z.number().int().nonnegative(),
}).strict();
const LastFailure = z.object({
  contractVersion: z.literal("tasq.last-failure.v1"),
  command: z.string().min(1).max(100),
  subcommand: z.string().min(1).max(100).nullable(),
  flags: z.array(z.string().regex(/^[A-Za-z0-9-]{1,100}$/)).max(100),
  exitCode: z.number().int().min(1).max(255),
  recordedAt: z.number().int().nonnegative(),
}).strict();
type Capture = z.infer<typeof Capture>;
type FeedbackEvent = Capture | z.infer<typeof Publication>;

const SAFE_SUBCOMMANDS: Record<string, ReadonlySet<string>> = {
  agent: new Set(["install", "instructions"]),
  area: new Set(["list", "show", "add", "update", "delete"]),
  attempt: new Set(["start", "succeed", "fail", "list"]),
  config: new Set(["show", "get", "set"]),
  contextLink: new Set(["attach", "detach", "list", "show"]),
  cost: new Set(["budget", "record", "show"]),
  evidence: new Set(["add", "list"]),
  journal: new Set(["checkpoint"]),
  observation: new Set(["ingest", "list", "show"]),
  premise: new Set(["show", "propose", "challenge", "decide"]),
  project: new Set(["list", "show", "add", "update", "delete", "status"]),
  remote: new Set(["enroll", "status", "list", "show", "events", "operations", "call", "logout"]),
  resolution: new Set(["contract", "trust", "propose", "challenge", "attest", "settle", "adjudicate", "show"]),
  resource: new Set(["acquire", "renew", "release", "verify", "get", "list", "events", "sweep"]),
  signature: new Set(["show", "bindings"]),
  summary: new Set(["add", "list", "show"]),
  task: new Set(["status"]),
  wait: new Set(["create", "list", "cancel", "sweep"]),
  web: new Set(["status"]),
};

function privateHome(): string {
  const home = configDir();
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const info = lstatSync(home);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Tasq home must be a real private directory");
  if ((info.mode & 0o077) !== 0) throw new Error("Tasq home must not be accessible by group or other users");
  return home;
}

function feedbackPath(): string {
  return join(privateHome(), "feedback.jsonl");
}

function lastFailurePath(): string {
  return join(privateHome(), "last-failure.json");
}

function appendEvent(event: FeedbackEvent): void {
  const path = feedbackPath();
  const line = `${JSON.stringify(event)}\n`;
  if (existsSync(path)) {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("feedback store must be a regular file");
    if ((info.mode & 0o077) !== 0) throw new Error("feedback store must be private");
    if (info.size + Buffer.byteLength(line) > MAX_STORE_BYTES) {
      throw new Error("feedback store would exceed the 10 MiB safety bound");
    }
    const count = readFileSync(path, "utf8").split("\n").filter(Boolean).length;
    if (count >= MAX_EVENTS) throw new Error("feedback store would exceed the 10000-event safety bound");
  }
  const fd = openSync(path, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    writeSync(fd, line, undefined, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function events(): FeedbackEvent[] {
  const path = feedbackPath();
  if (!existsSync(path)) return [];
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_STORE_BYTES) {
    throw new Error("feedback store is unsafe or exceeds the 10 MiB safety bound");
  }
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  if (lines.length > MAX_EVENTS) throw new Error("feedback store exceeds the 10000-event safety bound");
  return lines.map((line, index) => {
    try {
      const value: unknown = JSON.parse(line);
      return Capture.safeParse(value).success ? Capture.parse(value) : Publication.parse(value);
    } catch (error) {
      throw new Error(`invalid feedback event at line ${index + 1}: ${(error as Error).message}`);
    }
  });
}

function pendingReports(): Capture[] {
  const all = events();
  const published = new Set(all.filter((event) => event.type === "published").map((event) => event.id));
  return all.filter((event): event is Capture => event.type === "captured" && !published.has(event.id));
}

function readLastFailure(): z.infer<typeof LastFailure> | null {
  const path = lastFailurePath();
  if (!existsSync(path)) return null;
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 16_384) return null;
  try {
    return LastFailure.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

function writePrivateAtomic(path: string, value: string): void {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, value, { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function safeCommandShape(argv: string[]): Pick<z.infer<typeof LastFailure>, "command" | "subcommand" | "flags"> {
  const rawCommand = argv[0] ?? "unknown";
  const command = /^[A-Za-z0-9-]{1,100}$/.test(rawCommand) ? rawCommand : "unknown";
  const candidate = argv.find((value, index) => index > 0 && !value.startsWith("-"));
  const known = SAFE_SUBCOMMANDS[command];
  const subcommand = candidate && known?.has(candidate) ? candidate : null;
  const flags = [...new Set(argv.flatMap((value) => {
    const match = /^--([A-Za-z0-9-]{1,100})(?:=|$)/.exec(value);
    if (match) return [match[1]!];
    if (/^-[A-Za-z]{1,8}$/.test(value)) return [value.slice(1)];
    return [];
  }))].sort();
  return { command, subcommand, flags };
}

/** Persist only command shape, never positionals, flag values or error text. */
export function recordLastFailure(argv: string[], exitCode: number, clock: Clock): void {
  // Preserve cold validation's zero-mutation contract. Explicit `feedback`
  // capture may create its own private store, but an unrelated failed command
  // only leaves context when the operator already has a Tasq home.
  const home = configDir();
  if (!existsSync(home)) return;
  const homeInfo = lstatSync(home);
  if (!homeInfo.isDirectory() || homeInfo.isSymbolicLink() || (homeInfo.mode & 0o077) !== 0) return;
  const safeExit = Number.isSafeInteger(exitCode) && exitCode > 0 && exitCode <= 255 ? exitCode : 1;
  const event = LastFailure.parse({
    contractVersion: "tasq.last-failure.v1",
    ...safeCommandShape(argv),
    exitCode: safeExit,
    recordedAt: clock.now(),
  });
  writePrivateAtomic(join(home, "last-failure.json"), `${JSON.stringify(event)}\n`);
}

function positiveLimit(args: ParsedArgs): number {
  const value = args.number("limit") ?? 100;
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
    throw new Error("--limit must be an integer from 1 to 100");
  }
  return value;
}

function assertFeedbackFlags(args: ParsedArgs, allowed: readonly string[]): void {
  const known = new Set(["json", "j", "help", "h", ...allowed]);
  const unexpected = Object.keys(args.flags).filter((flag) => !known.has(flag));
  if (unexpected.length > 0) {
    throw new Error(`feedback form does not accept ${unexpected.map((flag) => `--${flag}`).join(", ")}`);
  }
}

export async function feedbackCmd(args: ParsedArgs, clock: Clock, version: string): Promise<number> {
  const [first, ...rest] = args.positional;
  const json = args.bool("json", "j");
  if (first === "list") {
    assertFeedbackFlags(args, []);
    if (rest.length > 0) throw new Error("feedback list accepts no positional arguments");
    const pending = pendingReports();
    const result = { contractVersion: "tasq.feedback-list.v1", pending, count: pending.length };
    if (json) printJson(result);
    else printInfo(pending.length === 0 ? "No pending feedback." : pending.map((item) => `${item.id}  ${item.summary}`).join("\n"));
    return 0;
  }
  if (first === "push") {
    assertFeedbackFlags(args, ["repo", "limit", "dry-run"]);
    if (rest.length > 0) throw new Error("feedback push accepts flags only");
    const repositoryInput = args.string("repo");
    if (!repositoryInput) throw new Error("feedback push requires --repo <owner/name>");
    const repository = parseGitHubRepositoryName(repositoryInput);
    const pending = pendingReports().slice(0, positiveLimit(args));
    if (args.bool("dry-run")) {
      const result = { contractVersion: "tasq.feedback-push-plan.v1", repository, count: pending.length, reportIds: pending.map(({ id }) => id) };
      if (json) printJson(result);
      else printInfo(`Would push ${pending.length} feedback report(s) to ${repository}.`);
      return 0;
    }
    const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
    if (!token) throw new Error("feedback push requires GH_TOKEN or GITHUB_TOKEN in the environment");
    const pushed = [];
    for (const report of pending) {
      const publication = await publishGitHubFeedbackIssue({
        repository,
        token,
        report: report as GitHubFeedbackReport,
      });
      const receipt = Publication.parse({
        contractVersion: "tasq.feedback-published.v1",
        type: "published",
        id: report.id,
        repository: publication.repository,
        issueNumber: publication.issueNumber,
        issueUrl: publication.issueUrl,
        disposition: publication.disposition,
        publishedAt: clock.now(),
      });
      appendEvent(receipt);
      pushed.push(receipt);
    }
    const result = { contractVersion: "tasq.feedback-push-result.v1", repository, pushed, count: pushed.length };
    if (json) printJson(result);
    else printInfo(pushed.length === 0 ? "No pending feedback." : pushed.map((item) => `${item.issueUrl} (${item.disposition})`).join("\n"));
    return 0;
  }

  if (!first || rest.length > 0) throw new Error('feedback "one-line summary" [--details <text>]');
  assertFeedbackFlags(args, ["details"]);
  const summary = first.trim();
  if (!summary || summary.length > 500 || /[\r\n]/.test(summary)) {
    throw new Error("feedback summary must be one non-empty line of at most 500 characters");
  }
  const details = args.string("details")?.trim() || null;
  if (details && details.length > 10_000) throw new Error("--details cannot exceed 10000 characters");
  const previous = readLastFailure();
  const report = Capture.parse({
    contractVersion: "tasq.feedback-captured.v1",
    type: "captured",
    id: randomUUID(),
    summary,
    details,
    capturedAt: clock.now(),
    context: {
      version,
      platform,
      architecture: arch,
      previousFailure: previous ? {
        command: previous.command,
        subcommand: previous.subcommand,
        flags: previous.flags,
        exitCode: previous.exitCode,
        recordedAt: previous.recordedAt,
      } : null,
    },
  });
  appendEvent(report);
  const result = { ...report, storedAt: feedbackPath(), pending: true };
  if (json) printJson(result);
  else printInfo(`Feedback saved locally (${report.id}). Push later with: tasq feedback push --repo <owner/name>`);
  return 0;
}
