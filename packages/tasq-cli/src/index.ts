#!/usr/bin/env bun
/**
 * @tasq/cli — the `tasq` binary.
 *
 * Routes the first positional arg to a command handler. Commands consume
 * `@tasq-internal/local-service` ; the CLI itself has no SQL.
 *
 * Exit codes (per TASQ_ZERO.md §6.3):
 *   0 success
 *   1 user error (bad args, not found)
 *   2 validation error
 *   3 storage error
 *   4 config error
 */

import { committedMutationCount, systemClock, type Clock } from "@tasq-internal/local-service";
import { parseArgs } from "./args.js";
import { errorMatches, errorMessage } from "./errors.js";
import { color, printError, printInfo } from "./output/format.js";
import { configCmd, init } from "./commands/init.js";
import { areaCmd } from "./commands/area.js";
import { goalCmd, projectCmd } from "./commands/goal-project.js";
import {
  addCmd,
  inboxCmd,
  listCmd,
  showCmd,
  transitionCmd,
  updateCmd,
} from "./commands/task.js";
import {
  eventCmd,
  nextCmd,
  projectionCmd,
  searchCmd,
} from "./commands/next-search-event-projection.js";
import { taskCmd, treeCmd } from "./commands/tree-status.js";
import { dependCmd, undependCmd } from "./commands/dependency.js";
import { backupCmd } from "./commands/backup.js";
import { doctorCmd } from "./commands/doctor.js";
import { journalCmd } from "./commands/journal.js";
import { attemptCmd, claimCmd, evidenceCmd, releaseCmd } from "./commands/agentic.js";
import { observationCmd, reconcileCmd, waitCmd } from "./commands/wait-observe.js";
import { commandUsage } from "./commands/usage.js";
import { inspectCmd } from "./commands/inspect.js";
import { discoverCmd } from "./commands/discover.js";
import { onboardCmd, printOnboardProblem } from "./commands/onboard.js";
import { resourceCmd } from "./commands/resource.js";
import { mcpCmd } from "./commands/mcp.js";
import { contextCmd } from "./commands/context.js";
import { summaryCmd } from "./commands/summary.js";
import { contextLinkCmd } from "./commands/context-link.js";
import { webCmd } from "./commands/web.js";

declare const TASQ_BUILD_VERSION: string;
const VERSION = typeof TASQ_BUILD_VERSION === "string" ? TASQ_BUILD_VERSION : "0.1.0";

const COMMON_FLAGS = ["json", "j", "actor", "tenant", "help", "h"] as const;

function assertKnownFlags(command: string, args: ReturnType<typeof parseArgs>): void {
  const byCommand: Record<string, readonly string[]> = {
    init: ["db", "projection"],
    onboard: ["space", "capabilities"],
    resource: ["lease", "fence", "revision", "idempotency-key", "for", "metadata", "reason", "active-only", "holder", "limit", "after-sequence"],
    mcp: ["capabilities"],
    web: ["host", "port"],
    config: [],
    area: ["slug", "importance", "cadence", "description", "name", "cascade"],
    goal: ["area", "status", "horizon", "importance", "description", "target-date", "title", "cascade"],
    project: ["area", "goal", "status", "description", "title", "cascade"],
    add: ["area", "goal", "project", "parent", "next", "description", "success", "completion", "priority", "est", "due", "schedule", "recurrence", "interval", "anchor", "metadata", "idempotency-key"],
    list: ["area", "goal", "project", "status", "limit", "include-scheduled", "include-deferred"],
    show: [],
    inspect: [],
    discover: ["hello"],
    update: ["title", "description", "next", "success", "completion", "priority", "est", "due", "schedule", "area", "goal", "project", "parent", "recurrence", "interval", "anchor", "metadata", "metadata-patch", "clear-description", "clear-next", "clear-success", "clear-priority", "clear-est", "clear-due", "clear-schedule", "clear-area", "clear-goal", "clear-project", "clear-parent", "clear-recurrence", "clear-metadata"],
    start: ["note", "source", "at"],
    done: ["note", "source", "at", "evidence"],
    complete: ["note", "source", "at", "evidence"],
    block: ["reason", "note", "source", "at"],
    unblock: ["note", "source", "at"],
    cancel: ["reason", "note", "source", "at"],
    reopen: ["note", "source", "at"],
    delete: ["cascade"],
    rm: ["cascade"],
    restore: [],
    next: ["limit", "area", "goal", "project", "include-scheduled", "include-deferred", "include-claimed"],
    context: ["max-records", "max-tokens", "include-deferred"],
    brief: ["max-records", "max-tokens", "include-deferred"],
    summary: ["text", "supersedes", "limit", "idempotency-key"],
    "context-link": ["system", "resource-type", "external-id", "url", "version", "digest", "purpose", "supersedes", "history", "limit", "idempotency-key"],
    search: [],
    inbox: ["limit", "include-scheduled", "include-deferred"],
    tree: [],
    task: [],
    depend: ["on", "type"],
    undepend: ["on", "type"],
    event: ["since", "before", "after-sequence", "before-sequence", "entity-id", "entity-type", "limit", "ascending"],
    projection: ["target"],
    backup: ["target", "rotate"],
    doctor: ["fix-permissions", "repair-outbox"],
    journal: ["accept-database", "reason", "dry-run"],
    claim: ["for", "until", "metadata", "idempotency-key"],
    release: ["reason", "force"],
    attempt: ["runtime", "external-id", "context-id", "claim", "metadata", "status", "message", "at", "limit", "idempotency-key"],
    evidence: ["kind", "summary", "uri", "digest", "source", "attempt", "supersedes", "observed-at", "metadata", "limit", "idempotency-key"],
    wait: ["kind", "parameters", "schema-version", "not-before", "deadline", "fallback-kind", "fallback-spec", "fallback-task", "supersedes", "idempotency-key", "status", "reason", "at", "matcher-version", "limit", "ascending"],
    observation: ["source", "external-event-id", "kind", "payload", "schema-version", "occurred-at", "verification-level", "verification-method", "raw-ref", "digest", "metadata", "occurred-from", "occurred-to", "after-recorded-at", "after-id", "limit", "ascending"],
    reconcile: ["matcher-version", "observation", "decision", "effect", "limit", "ascending"],
  };
  args.assertKnown([...COMMON_FLAGS, ...(byCommand[command] ?? [])]);
}

function printHelp(): void {
  printInfo(`${color.bold("tasq")} — agent-first task substrate (v${VERSION})

${color.bold("USAGE")}
  tasq <command> [args...] [--json]

${color.bold("SETUP")}
  onboard --space <id> --actor <label> --json
                                create/join a space + return executable recipes
  init                          create ~/.tasq/db.sqlite + config
  config [show|get|set <k> <v>] manage ~/.tasq/config.json

${color.bold("AREAS")}
  area list                     list all areas
  area show <slug>              show area details
  area add <name> --slug <s> [--importance 1-5] [--cadence <text>]
  area update <slug> [...]
  area delete <slug>

${color.bold("GOALS")}
  goal list [--area <slug>] [--status active|paused|done|abandoned]
  goal add <title> --area <slug> [--horizon <text>] [--importance 1-5]
  goal update <id> [--status ...] [--horizon ...] [--importance ...]

${color.bold("PROJECTS")}
  project list [--status ...] [--goal <id>]
  project add <title> [--goal <id>] [--area <slug>]
  project update <id> [--status ...]

${color.bold("TASKS — the core verbs")}
  add <title> [--area <slug>] [--goal <id>] [--project <id>]
              [--next <text>] [--due <iso>] [--est <min>] [--priority 1-5]
              [--recurrence daily|weekly|monthly|yearly] [--interval N]
              [--anchor due|scheduled|completion] [--success <criteria>]
              [--completion assertion|evidence] [--idempotency-key <key>]
  list [--status ...] [--area <slug>] [--goal <id>] [--project <id>]
  show <id>
  inspect <id> [--json]          canonical commitment graph + resume cursor
  update <id> [--title ...] [--next ...] [--due ...] [--recurrence ...] [...]
  start <id> [--note <text>]
  done <id> [--evidence <id,...>] [--note <text>] [--source <text>] [--at <iso>]
  block <id> --reason <text>
  unblock <id>
  cancel <id> [--reason <text>]
  reopen <id>
  delete <id>
  restore <id>

${color.bold("DEPENDENCIES")}
  depend <id> --on <other-id> [--type blocks|relates_to|duplicates]
                                 record that <id> depends on <other-id>
  undepend <id> --on <other-id> [--type ...]
                                 remove a dependency edge

${color.bold("AGENT COORDINATION")}
  claim <id> [--for 30m]         atomically claim work (repeat to heartbeat)
  release <id>                   release the current claim
  attempt start <id> [...]       record one concrete execution
  attempt succeed|fail <id>      close an execution attempt
  evidence add <id> --kind ...   attach an observable receipt
  evidence list [<id>]           inspect completion evidence
  resource acquire|renew|release|verify|get|list|events|sweep
                                 coordinate any opaque external resource key
  mcp --tenant <space> --actor <label> [--capabilities read,coordinate]
                                 run a capability-scoped local MCP stdio server
  web --tenant <space> [--host 127.0.0.1] [--port 4137]
                                 explicit foreground read-only Local Console
  web status --tenant <space> --json
                                 prove a registered Console listener is live

${color.bold("WAIT / OBSERVE / RECONCILE")}
  wait create <task> --kind <kind> --parameters <json> [--deadline <iso>]
  wait list [task]                inspect typed external expectations
  wait cancel <wait> --reason <text>
  wait sweep [--at <iso>]         reconcile queued facts, then expire due waits
  observation ingest --source <s> --external-event-id <id>
                     --kind <kind> --payload <json> --occurred-at <iso>
  observation list|show [...]     inspect immutable normalized facts
  reconcile <wait> <observation>  run the frozen deterministic matcher
  reconcile list [wait]           inspect immutable decisions and effects

${color.bold("MACHINE DISCOVERY")}
  discover [--json]                  capabilities, extensions, schemas + cursors
  discover schema <resource-id>      fetch one digest-bound JSON Schema
  discover negotiate --hello <json>  strict cold-start compatibility handshake

${color.bold("VIEWS")}
  context [--max-records N] [--max-tokens N] [--json]
                                 bounded reason-traced universal state packet
  summary add|list|show [...]    source-bound compact context for closed work
  context-link attach|detach|list|show [...]
                                 reusable external context pointers; no content
  next [--limit N] [--area <slug>]   prioritized next-action list
  search "<query>"                   substring search across task text
  inbox                              tasks without project
  tree <id>                          show a task + its sub-tasks
  task status <id>                   progress + ETA for a task w/ sub-tasks
  project status <id>                progress + ETA for a project

${color.bold("AUDIT")}
  event list [--since <iso>] [--entity-id <id>] [--actor <name>]
              [--entity-type area|goal|project|task]
              [--after-sequence N] [--ascending]

${color.bold("PROJECTION")}
  projection [--target <path>]   regenerate markdown projection
                                 (writes to config.projectionTarget if no --target)

${color.bold("DURABILITY")}
  backup [<path>] [--rotate N]   snapshot DB to ~/.tasq/snapshots/db-<ts>.sqlite
                                 (keeps last N snapshots if --rotate is set)
  doctor [--fix-permissions] [--repair-outbox]
                                verify/repair delivery, journal and private modes
  journal checkpoint --accept-database --reason <text>
                                 archive history and accept the DB cursor baseline

${color.bold("META")}
  version                        print version
  help [command]                 this message

${color.bold("FLAGS")}
  --json / -j                    machine-readable JSON output
  --actor <name>                 override default actor
  --tenant <id>                  override default tenant (rare)

${color.dim("Docs: CURRENT_STATE.md, SKILL.md, BACKLOG.md")}`);
}

export async function main(
  argv: string[],
  clock: Clock = systemClock,
  executable = "tasq",
): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    // `tasq help <cmd>` / `tasq --help <cmd>` → that command's usage (the
    // documented `help [command]` form). Bare `help` → the full message.
    if (command === "help" || command === "--help" || command === "-h") {
      const sub = rest[0];
      const usage = sub ? commandUsage(sub) : undefined;
      if (usage) {
        printInfo(usage);
        return 0;
      }
    }
    printHelp();
    return 0;
  }
  if (command === "version" || command === "--version" || command === "-v") {
    printInfo(VERSION);
    return 0;
  }

  // Note: we pass `rest` to parseArgs (NOT [command, ...rest]) so that
  // positional[0] for sub-handlers is the sub-command (e.g. for `area add`,
  // positional[0] = "add"). The top-level `command` itself is consumed here.
  const args = parseArgs(rest);

  // Help intercept: `tasq <cmd> --help`/`-h` (the flag lands in `rest`, so the
  // command handler would otherwise run with empty positionals and fall through
  // to a misleading default — e.g. `event` dumping the log, `task` printing the
  // status line). Also `tasq <cmd> help`. Print THAT command's usage on stdout
  // and exit 0, before dispatch. Only --help/-h/bare `help` trigger this; the
  // --json/-j machine-output flag is untouched.
  if (args.bool("help", "h") || rest[0] === "help") {
    const usage = commandUsage(command);
    if (usage) {
      printInfo(usage);
      return 0;
    }
  }

  try {
    // Resource owns validation so every `--json` failure, including an unknown
    // flag, can stay on its typed stdout-only problem channel.
    if (command !== "resource") assertKnownFlags(command, args);
    switch (command) {
      case "init":
        return await init(args);
      case "onboard":
        return await onboardCmd(args, clock, executable);
      case "resource":
        return await resourceCmd(args, clock);
      case "mcp":
        return await mcpCmd(args, clock);
      case "web":
        return await webCmd(args, clock, undefined, VERSION);
      case "config":
        return await configCmd(args);

      // Areas / goals / projects
      case "area":
        return await areaCmd(args);
      case "goal":
        return await goalCmd(args);
      case "project":
        return await projectCmd(args);

      // Task verbs (top-level)
      case "add":
        return await addCmd(args);
      case "list":
        return await listCmd(args);
      case "show":
        return await showCmd(args);
      case "inspect":
        return await inspectCmd(args);
      case "discover":
        return await discoverCmd(args);
      case "update":
        return await updateCmd(args);
      case "start":
        return await transitionCmd("start", args);
      case "done":
      case "complete":
        return await transitionCmd("done", args);
      case "block":
        return await transitionCmd("block", args);
      case "unblock":
        return await transitionCmd("unblock", args);
      case "cancel":
        return await transitionCmd("cancel", args);
      case "reopen":
        return await transitionCmd("reopen", args);
      case "delete":
      case "rm":
        return await transitionCmd("delete", args);
      case "restore":
        return await transitionCmd("restore", args);

      // Discovery
      case "next":
        return await nextCmd(args);
      case "context":
      case "brief":
        return await contextCmd(args, clock);
      case "summary":
        return await summaryCmd(args, clock);
      case "context-link":
        return await contextLinkCmd(args, clock);
      case "search":
        return await searchCmd(args);
      case "inbox":
        return await inboxCmd(args);
      case "tree":
        return await treeCmd(args);
      case "task":
        return await taskCmd(args);

      // Dependencies (SPEC §4.5 — first-class peer task_dependency)
      case "depend":
        return await dependCmd(args);
      case "undepend":
        return await undependCmd(args);

      // Audit
      case "event":
        return await eventCmd(args);

      // Projection
      case "projection":
        return await projectionCmd(args);

      // Durability
      case "backup":
        return await backupCmd(args);
      case "doctor":
        return await doctorCmd(args);
      case "journal":
        return await journalCmd(args);
      case "claim":
        return await claimCmd(args);
      case "release":
        return await releaseCmd(args);
      case "attempt":
        return await attemptCmd(args);
      case "evidence":
        return await evidenceCmd(args);
      case "wait":
        return await waitCmd(args);
      case "observation":
        return await observationCmd(args);
      case "reconcile":
        return await reconcileCmd(args);

      default:
        printError(`unknown command: ${command}`);
        printError(`run \`tasq help\` for usage`);
        return 1;
    }
  } catch (err) {
    if (err instanceof Error) {
      // Transient SQLite contention bubbles up to runWithRetry, which only
      // replays read-only commands (mutations are atomic + serialized; see
      // its doc comment). Mutating commands surface exit 3 there rather than
      // risk a double-apply on replay — so we just re-throw here.
      if (errorMatches(err, /SQLITE_BUSY|database is locked/i)) throw err;

      // Zod errors are common ; surface them cleanly
      const message = errorMessage(err);
      const isZod = err.name === "ZodError";
      const isFK = errorMatches(err, /FOREIGN KEY|REFERENCES/);
      const isUnique = errorMatches(err, /UNIQUE constraint/);
      const isCheck = errorMatches(err, /CHECK constraint/);
      // enumArg rejects an out-of-set flag value (e.g. --recurrence hourly) with
      // a "Invalid value for --<flag>" message — that is a validation error, same
      // class as a Zod parse failure, so it shares exit code 2.
      const isEnumArg = /^Invalid value for --/.test(message);
      const isArgError = /^(Unknown flag|Missing value for --|Invalid (number|boolean) for --|Invalid JSON for --|--.+ must be a JSON object)/.test(message);

      if (command === "onboard" && args.flag("json", "j") !== undefined) {
        return printOnboardProblem(err, executable);
      }

      printError(message);

      if (isZod) return 2;
      if (isFK || isUnique || isCheck) return 2;
      if (isEnumArg || isArgError) return 2;
      if (/^Config error/.test(message)) return 4;
      if (errorMatches(err, /database|disk|permission|SQLITE/i)) return 3;
      return 1;
    }
    printError(String(err));
    return 1;
  }
}

/**
 * Run `main`, retrying transient SQLite contention only when a whole-command
 * replay is PROVABLY safe (cannot double-apply). Concurrency model after the
 * atomicity work:
 *
 *   - Every mutation is transactional. For task-scoped mutations, the row
 *     write + `recordEvent` insert commit or roll back together inside one
 *     `db.transaction` (serialized per connection — see tasq-service
 *     `runInTransaction`). Observation ingestion is also atomic but has no
 *     task event until reconciliation. A SQLITE_BUSY *during* a mutation
 *     rolls the WHOLE transaction back, leaving zero committed rows.
 *   - In-transaction / cross-process write contention is absorbed by
 *     `busy_timeout = 30000` (set in tasq-service `openDb`): SQLite blocks
 *     for the writer lock before surfacing BUSY.
 *   - Whole-command replay is NOT idempotent for creates: `tasq add` (and the
 *     other create verbs) mint a FRESH uuidv7 on every run, so replaying a
 *     command whose mutation already COMMITTED would insert a DUPLICATE.
 *
 * The safe-replay test is therefore exact, not a command-name guess: sample
 * the process-global committed-domain-mutation count before each attempt. If
 * a transient BUSY is thrown and the count did NOT advance, then no domain
 * mutation committed this attempt — the BUSY hit connection-open, WAL
 * recovery (`SQLITE_BUSY_RECOVERY` on cold-start fan-out), migration, a read,
 * local delivery bookkeeping, or a fully rolled-back transaction — so replay
 * cannot double-apply and we retry. If the count advanced, a domain mutation
 * already committed (and some *later* step tripped BUSY), so we must NOT
 * replay: surface exit 3 instead. (True
 * end-to-end idempotency for retried writes is the job of the API
 * idempotency_key, not the CLI.)
 *
 * Backoff is exponential with small jitter, ~6.3s total across 7 attempts.
 */
export async function runWithRetry(
  argv: string[],
  clock: Clock = systemClock,
  executable = "tasq",
): Promise<number> {
  const maxAttempts = 7;
  const baseDelayMs = 100;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const committedBefore = committedMutationCount();
    try {
      return await main(argv, clock, executable);
    } catch (err) {
      const msg = errorMessage(err);
      const isTransient = errorMatches(err, /SQLITE_BUSY|database is locked/i);
      if (!isTransient) throw err;
      // Did a domain mutation commit during this attempt? If so, replaying the
      // whole command would double-apply (fresh uuidv7) — never replay; exit 3.
      const committedThisAttempt = committedMutationCount() > committedBefore;
      // Autonomous bootstrap is create-or-join with deterministic principal
      // identity, so a lost response after commit is contractually replayable.
      // Historical create commands are not and retain the strict guard.
      const contractuallyReplayable = argv[0] === "onboard";
      if ((committedThisAttempt && !contractuallyReplayable) || attempt === maxAttempts) {
        const finalMessage = committedThisAttempt && !contractuallyReplayable
          ? `${msg} (a mutation already committed — not retrying to avoid a duplicate)`
          : `${msg} (retried ${maxAttempts} times)`;
        if (argv[0] === "onboard" && argv.some((value) => value === "--json" || value === "-j" || value.startsWith("--json="))) {
          return printOnboardProblem(new Error(finalMessage), executable);
        }
        printError(finalMessage);
        return 3;
      }
      // Exponential backoff with small jitter: 100, 200, 400, 800ms
      const delay = baseDelayMs * 2 ** (attempt - 1) + Math.floor(Math.random() * 50);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  // Unreachable — the loop either returns or throws.
  return 1;
}

export async function runTasqCli(
  argv: string[],
  clock: Clock = systemClock,
  executable = "tasq",
): Promise<number> {
  try {
    return await runWithRetry(argv, clock, executable);
  } catch (err) {
    if (argv[0] === "onboard" && argv.some((value) => value === "--json" || value === "-j" || value.startsWith("--json="))) {
      return printOnboardProblem(err, executable);
    }
    printError(errorMessage(err));
    return 1;
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  process.exit(await runTasqCli(argv, systemClock, process.argv[1] ?? "tasq"));
}
