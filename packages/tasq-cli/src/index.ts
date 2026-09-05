#!/usr/bin/env bun
/**
 * @tasq-run/cli — the `tasq` binary.
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

import {
  committedMutationCount,
  MigrationSafetyError,
  STORE_FORMAT_COMPATIBILITY,
  StoreCompatibilityError,
  CostBoundError,
  systemClock,
  type Clock,
} from "@tasq-internal/local-service";
import { parseArgs } from "./args.js";
import { errorMatches, errorMessage } from "./errors.js";
import { color, printError, printInfo, printJson, takeLastErrorMessage } from "./output/format.js";
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
import { portableExportCmd, portableImportCmd } from "./commands/portable.js";
import { agentCmd, demoCmd, setupCmd } from "./commands/adoption.js";
import { resolutionCmd } from "./commands/resolution.js";
import { remoteCmd } from "./commands/remote.js";
import { signatureCmd } from "./commands/signature.js";
import { captureCmd } from "./commands/capture.js";
import { becauseCmd, resumeCmd, whyCmd, wrongCmd } from "./commands/assumption.js";
import { fleetCmd } from "./commands/fleet.js";
import { storeCmd } from "./commands/store.js";
import { costCmd } from "./commands/cost.js";
import { premiseCmd } from "./commands/premise.js";
import { useCmd } from "./commands/use.js";
import { whoamiCmd } from "./commands/whoami.js";
import { contentionCmd } from "./commands/contention.js";
import { feedbackCmd, recordLastFailure } from "./commands/feedback.js";

declare const TASQ_BUILD_VERSION: string;
const VERSION = typeof TASQ_BUILD_VERSION === "string" ? TASQ_BUILD_VERSION : "0.1.0";

const COMMON_FLAGS = ["json", "j", "actor", "tenant", "help", "h"] as const;

/**
 * Per-command help used to omit the flags that work on EVERY command, so a
 * reader of `tasq help evidence` never learned that `--actor` exists there.
 * That is how evidence gets filed under the wrong principal. Only explicit
 * help requests get this; the same usage strings are reused verbatim in
 * argument errors, which stay terse.
 */
function withGlobalFlags(usage: string): string {
  return `${usage}

Also on every command:
  --json / -j                    machine-readable JSON output
  --actor <name>                 attribute this call to a principal
  --tenant <id>                  override the default space (rare)`;
}

function assertKnownFlags(command: string, args: ReturnType<typeof parseArgs>): void {
  const byCommand: Record<string, readonly string[]> = {
    init: ["db", "projection"],
    setup: ["space", "no-bind", "no-instructions", "target", "force", "default"],
    use: ["clear", "from-instructions", "project-to", "no-projection"],
    whoami: [],
    contention: ["since"],
    feedback: ["details", "repo", "limit", "dry-run"],
    demo: [],
    agent: ["space", "capabilities", "executable", "target", "apply", "write", "check", "force"],
    onboard: ["space", "capabilities"],
    resource: ["lease", "fence", "revision", "idempotency-key", "for", "metadata", "reason", "active-only", "holder", "limit", "after-sequence"],
    mcp: ["capabilities", "completion"],
    remote: [
      "profile", "endpoint", "workspace", "token", "replace", "cursor", "limit",
      "after-sequence", "resource-kind", "resource-id", "input", "idempotency-key",
      "expected-revision", "request-id",
    ],
    web: ["host", "port"],
    config: [],
    area: ["slug", "importance", "cadence", "description", "name", "cascade"],
    goal: ["area", "status", "horizon", "importance", "description", "target-date", "title", "cascade"],
    project: ["area", "goal", "status", "description", "title", "cascade"],
    add: ["area", "goal", "project", "parent", "next", "description", "success", "completion", "validated", "priority", "est", "due", "schedule", "recurrence", "interval", "anchor", "metadata", "because", "premise-observation", "premise", "premise-validators", "premise-adjudicators", "premise-allow-self", "idempotency-key"],
    list: ["area", "goal", "project", "status", "priority", "limit", "include-scheduled", "include-deferred"],
    show: [],
    inspect: [],
    discover: ["hello"],
    update: ["title", "description", "next", "success", "completion", "validated", "priority", "est", "due", "schedule", "area", "goal", "project", "parent", "recurrence", "interval", "anchor", "metadata", "metadata-patch", "clear-description", "clear-next", "clear-success", "clear-priority", "clear-est", "clear-due", "clear-schedule", "clear-area", "clear-goal", "clear-project", "clear-parent", "clear-recurrence", "clear-metadata"],
    start: ["reason", "note", "source", "at", "expected-revision", "idempotency-key"],
    done: ["reason", "note", "source", "at", "evidence", "decision", "expected-revision", "idempotency-key", "force"],
    complete: ["reason", "note", "source", "at", "evidence", "decision", "expected-revision", "idempotency-key", "force"],
    block: ["reason", "note", "source", "at", "expected-revision", "idempotency-key"],
    unblock: ["reason", "note", "source", "at", "expected-revision", "idempotency-key"],
    cancel: ["reason", "note", "source", "at", "expected-revision", "idempotency-key", "force"],
    reopen: ["reason", "note", "source", "at", "expected-revision", "idempotency-key"],
    delete: ["cascade"],
    rm: ["cascade"],
    restore: [],
    next: ["limit", "area", "goal", "project", "priority", "include-scheduled", "include-deferred", "include-claimed"],
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
    capture: ["next", "context", "source", "idempotency-key"],
    wrong: ["reason", "evidence"],
    why: [],
    resume: ["reason"],
    because: ["status"],
    store: ["force", "to"],
    fleet: [],
    event: ["since", "before", "after-sequence", "before-sequence", "entity-id", "entity-type", "limit", "ascending"],
    projection: ["target"],
    backup: ["target", "rotate"],
    export: ["max-records", "max-bytes"],
    import: ["db"],
    doctor: ["fix-permissions", "repair-outbox", "config", "prune-bindings"],
    journal: ["accept-database", "reason", "dry-run"],
    claim: ["for", "until", "metadata", "force", "idempotency-key"],
    cost: ["currency", "max-micros", "reserve-micros", "metering", "meter", "observation", "gross-micros", "basis", "observed-at", "idempotency-key"],
    release: ["reason", "force"],
    attempt: ["runtime", "external-id", "context-id", "claim", "metadata", "status", "message", "note", "at", "limit", "expected-revision", "idempotency-key"],
    evidence: ["kind", "summary", "uri", "digest", "source", "attempt", "supersedes", "observed-at", "metadata", "limit", "idempotency-key"],
    resolution: ["criteria", "policy", "policy-uri", "policy-version", "implementation-digest", "validators", "adjudicators", "challenge-window-ms", "allow-self-validation", "not-before", "metadata", "contract", "criterion-evidence", "summary", "evidence", "reason", "retention-until", "reason-code", "explanation", "counter-evidence", "outcome", "supersedes", "idempotency-key"],
    premise: ["verdict", "evidence", "reason", "proposal", "counter-evidence", "outcome", "idempotency-key"],
    signature: [],
    wait: ["kind", "parameters", "schema-version", "not-before", "deadline", "fallback-kind", "fallback-spec", "fallback-task", "supersedes", "idempotency-key", "status", "reason", "at", "matcher-version", "limit", "ascending"],
    observation: ["source", "external-event-id", "kind", "payload", "schema-version", "occurred-at", "verification-level", "verification-method", "raw-ref", "digest", "metadata", "occurred-from", "occurred-to", "after-recorded-at", "after-id", "limit", "ascending"],
    reconcile: ["matcher-version", "observation", "decision", "effect", "limit", "ascending"],
  };
  args.assertKnown([...COMMON_FLAGS, ...(byCommand[command] ?? [])]);
}

function printHelp(): void {
  printInfo(`${color.bold("tasq")} - the project tracker you share with your agents (v${VERSION})

${color.bold("USAGE")}
  tasq <command> [args...] [--json]

${color.bold("SETUP")}
  setup [--space <id>] [--actor <label>] [--no-bind] [--no-instructions] [--default]
                                everything a new project needs: join the space,
                                bind this directory, write the AGENTS.md block;
                                the global default moves only with --default
  use [<space>|--clear|--from-instructions] [--project-to <file>|--no-projection]
                                bind/show this directory's space; keep global default;
                                --from-instructions binds what AGENTS.md declares;
                                --project-to renders this space's TASKS.md inside the project
  whoami                        who this ledger thinks is writing, and what that proves
  contention [--since 7d]       what the ledger refused: collisions it prevented
  onboard --space <id> --actor <label> --json
                                create/join a space + return executable recipes
  demo [--json]                 isolated add → list → done journey; no live data
  init                          create ~/.tasq/db.sqlite + config
  config [show|get|set <k> <v>] manage ~/.tasq/config.json
  feedback "summary"             capture actionable context locally, even offline

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
                                 --completion evidence requires --success;
                                 --validated requires --completion evidence
  list [--status ...] [--area <slug>] [--goal <id>] [--project <id>]
       [--priority 1-5]
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
  depend <id> --on <other-id> [--type blocks|discovered_from|relates_to|duplicates]
                                 record that <id> depends on <other-id>
  undepend <id> --on <other-id> [--type ...]
                                 remove a dependency edge
  capture <id> <title> [--context <json>] [--idempotency-key <key>]
                                 atomically file linked work; keep current claim

${color.bold("WHY THE WORK EXISTS")}
  add <title> --because "<one sentence>"
                                 record what this work rests on; several tasks
                                 can rest on the same sentence
  wrong "<sentence>" --reason <text> [--evidence <id,...>]
                                 that turned out false: pauses every task
                                 resting on it. Nothing is cancelled.
  why <id>                       the chain: what this rests on, who stated it,
                                 who withdrew it and on what evidence
  resume <id> --reason <text>    continue a paused task anyway; unlinks it from
                                 the withdrawn sentence and records why
  because list [--status standing|withdrawn]
                                 what this workspace currently believes
  because attach <id> "<sentence>"
                                 bind an existing task to a sentence

${color.bold("AGENT COORDINATION")}
  agent install codex|claude|generic --space <id> --actor <label>
                                 preview an exact host-bound MCP registration
  agent instructions --space <id> [--write|--check]
                                 manage the versioned Tasq block in AGENTS.md
  fleet                          who is holding what right now, and for how
                                 much longer their lease runs
  claim <id> [--for 30m] [--force]
                                 atomically claim work (repeat to heartbeat);
                                 --force takes work whose blockers are unresolved
  release <id>                   release the current claim
  attempt start <id> [...]       record one concrete execution
  attempt succeed|fail <id>      close an execution attempt
  evidence add <id> --kind ...   attach an observable receipt
  evidence list [<id>]           inspect completion evidence
  cost budget|record|show ...    bound and inspect observed attempt cost
  signature show <id>            inspect exact accepted signed proof
  signature bindings [record]    inspect typed proof bindings (read-only)
  resolution contract|trust|propose|challenge|attest|settle|adjudicate|show
                                 independently validate completion
  premise show|propose|challenge|decide
                                 inspect or refute why a commitment exists
  resource acquire|renew|release|verify|get|list|events|sweep
                                 coordinate any opaque external resource key
  mcp --tenant <space> --actor <label> [--capabilities read,coordinate]
      [--completion assertion|evidence]
                                 run a capability-scoped local MCP stdio server
  web --tenant <space> [--host 127.0.0.1] [--port 4137]
                                 explicit foreground read-only Local Console
  web status --tenant <space> --json
                                 prove a registered Console listener is live

${color.bold("REMOTE SERVER")}
  remote enroll --endpoint <https-url> --workspace <id> [--profile <name>]
                                 redeem TASQ_ENROLLMENT_TOKEN into a private profile
  remote status [--profile <name>]
  remote list|show|events|operations [--profile <name>] [--json]
  remote call <operation> --resource-kind <kind> --resource-id <id>
              --input <json> --idempotency-key <key> [--expected-revision <n>]
  remote logout [--profile <name>]
                                 remove local credentials; server revocation is separate

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
  next [--limit N] [--area <slug>] [--priority 1-5]
                                     prioritized next-action list
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

${color.bold("STORE SAFETY")}
  store status                   what format this store is, and whether opening
                                 it would apply an irreversible upgrade
  store upgrade                  apply a pending format upgrade deliberately;
                                 a verified snapshot is written first
  store recovery-points          verified snapshots written before each upgrade
  store restore <id> [--force]   roll back to one, after checking its digest
  store clone --to <dir>         an independent copy to work on: WAL-safe, with
                                 every path rewritten inside the copy

${color.bold("DURABILITY")}
  backup [<path>] [--rotate N]   snapshot DB to ~/.tasq/snapshots/db-<ts>.sqlite
                                 (keeps last N snapshots if --rotate is set)
  export [<path>]                bounded portable workspace export (not a backup)
  import <export.json> --db <new-db-path>
                                 validate fully, then create one new store
  doctor [--config] [--fix-permissions] [--repair-outbox] [--prune-bindings]
                                verify/repair config, delivery, journal and private modes;
                                --config checks bindings and drift without opening the store
  journal checkpoint --accept-database --reason <text>
                                 archive history and accept the DB cursor baseline

${color.bold("META")}
  version                        print version
  help [command]                 this message

${color.bold("FLAGS")}
  --json / -j                    machine-readable JSON output
  --actor <name>                 override default actor
  --tenant <id>                  override default tenant (rare)

${color.dim("Agent start: tasq onboard --space <id> --actor <label> --json")}`);
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
        printInfo(withGlobalFlags(usage));
        return 0;
      }
      if (usage) {
        printInfo(usage);
        return 0;
      }
    }
    printHelp();
    return 0;
  }
  if (command === "version" || command === "--version" || command === "-v") {
    if (rest.some((value) => value === "--json" || value === "-j" || value === "--json=true")) {
      printJson({
        contractVersion: "tasq.executable-version.v1",
        version: VERSION,
        storeFormat: STORE_FORMAT_COMPATIBILITY,
      });
    } else {
      printInfo(VERSION);
    }
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
      printInfo(withGlobalFlags(usage));
      return 0;
    }
  }

  try {
    // Resource owns validation so every `--json` failure, including an unknown
    // flag, can stay on its typed stdout-only problem channel.
    if (command !== "resource") assertKnownFlags(command, args);
    const dispatched = await dispatch(command, args, rest, clock, executable);
    // Commands that refuse by printing and returning non-zero never reach the
    // catch below, so `--json` callers used to get an empty stdout for a whole
    // class of refusals (an unresolvable id, a missing required argument).
    // `args.bool` THROWS on a malformed value (`--json=maybe`), so asking it
    // here would turn a clean typed refusal into an exception. And `resource`
    // owns a stdout-only problem channel with a strict empty-stderr contract,
    // so it must never receive this generic envelope on top of its own.
    const wantsJson = args.flag("json", "j") !== undefined;
    if (dispatched !== 0 && wantsJson && command !== "resource") {
      const summary = takeLastErrorMessage();
      if (summary !== null) {
        printJson({
          contractVersion: "tasq.command-problem.v1",
          ok: false,
          command,
          code: dispatched === 2 ? "validation" : dispatched === 3 ? "storage" : dispatched === 4 ? "config" : "refused",
          summary,
          exitCode: dispatched,
        });
      }
    }
    return dispatched;
  } catch (err) {
    return handleCommandError(err, command, args, executable);
  }
}

async function dispatch(
  command: string,
  args: ReturnType<typeof parseArgs>,
  rest: string[],
  clock: Clock,
  executable: string,
): Promise<number> {
  {
    switch (command) {
      case "init":
        return await init(args);
      case "setup":
        return await setupCmd(args, clock);
      case "use":
        return await useCmd(args);
      case "whoami":
        return await whoamiCmd(args, clock);
      case "contention":
        return await contentionCmd(args, clock);
      case "feedback":
        return await feedbackCmd(args, clock, VERSION);
      case "demo":
        return await demoCmd(args, executable);
      case "agent":
        return await agentCmd(args, executable);
      case "onboard":
        return await onboardCmd(args, clock, executable);
      case "resource":
        return await resourceCmd(args, clock);
      case "mcp":
        return await mcpCmd(args, clock);
      case "remote":
        return await remoteCmd(args, clock);
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
      case "capture":
        return await captureCmd(args, clock);

      // Shared assumptions (ADR-021): why work exists, and what dies with it
      case "wrong":
        return await wrongCmd(args);
      case "why":
        return await whyCmd(args);
      case "resume":
        return await resumeCmd(args);
      case "because":
        return await becauseCmd(args);

      case "fleet":
        return await fleetCmd(args);

      // Store safety envelope (recovery points and their rollback rule)
      case "store":
        return await storeCmd(args, clock);

      // Audit
      case "event":
        return await eventCmd(args);

      // Projection
      case "projection":
        return await projectionCmd(args);

      // Durability
      case "backup":
        return await backupCmd(args);
      case "export":
        return await portableExportCmd(args, clock);
      case "import":
        return await portableImportCmd(args, clock);
      case "doctor":
        return await doctorCmd(args);
      case "journal":
        return await journalCmd(args);
      case "claim":
        return await claimCmd(args);
      case "cost":
        return await costCmd(args);
      case "release":
        return await releaseCmd(args);
      case "attempt":
        return await attemptCmd(args);
      case "evidence":
        return await evidenceCmd(args);
      case "resolution":
        return await resolutionCmd(args, clock);
      case "premise":
        return await premiseCmd(args);
      case "signature":
        return await signatureCmd(args);
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
  }
}

function handleCommandError(
  err: unknown,
  command: string,
  args: ReturnType<typeof parseArgs>,
  executable: string,
): number {
  {
    if (err instanceof Error) {
      // Transient SQLite contention bubbles up to runWithRetry, which only
      // replays read-only commands (mutations are atomic + serialized; see
      // its doc comment). Mutating commands surface exit 3 there rather than
      // risk a double-apply on replay — so we just re-throw here.
      if (errorMatches(err, /SQLITE_BUSY|database is locked/i)) throw err;

      // Zod errors are common ; surface them cleanly
      const message = errorMessage(err);
      if ((err instanceof StoreCompatibilityError || err instanceof MigrationSafetyError) && args.bool("json", "j")) {
        printJson(err.toJSON());
        return 3;
      }
      if (err instanceof CostBoundError && args.bool("json", "j")) {
        printJson({
          contractVersion: "tasq.cost-bound-problem.v1",
          ok: false,
          code: err.code,
          summary: err.summary,
        });
        return 2;
      }
      // A store the running binary cannot recognise is usually not a corrupt
      // store: it is the wrong binary. A stale global install resolves to
      // another checkout and reports a migration name that means nothing to the
      // reader, who then debugs the database instead of their PATH.
      if (err instanceof StoreCompatibilityError && /missing from this executable/.test(message)) {
        printError(message);
        printError(
          `This usually means the running program is not the one this store belongs to.\n`
          + `  running: ${process.argv[1] ?? executable}\n`
          + `Check which program you are invoking, then retry with the one that matches this store.`,
        );
        return 3;
      }

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

      // Classify once: the exit code and the machine-channel problem code are
      // the same decision, and they must not drift apart.
      const isConfig = /^Config error/.test(message);
      const isStorage = errorMatches(err, /database|disk|permission|SQLITE/i);
      const exitCode = isZod || isFK || isUnique || isCheck || isEnumArg || isArgError
        ? 2
        : isConfig
          ? 4
          : isStorage
            ? 3
            : 1;
      const code = isEnumArg || isArgError
        ? "usage"
        : isZod || isFK || isUnique || isCheck
          ? "validation"
          : isConfig
            ? "config"
            : isStorage
              ? "storage"
              : "refused";

      // A `--json` caller drives Tasq programmatically. Printing only to stderr
      // and leaving stdout empty tells an agent nothing it can act on — and it
      // hit the product's own differentiator, since an evidence-mode completion
      // refusal came back as an empty machine channel. Every non-zero exit now
      // carries a problem contract. Typed contracts above (store compatibility,
      // cost bounds, onboard) keep their richer shapes and return earlier.
      // stderr keeps the human diagnostic in every mode: a JSON consumer reads
      // stdout, and existing callers (plus tests) rely on the stderr text.
      printError(message);
      if (args.bool("json", "j")) {
        printJson({
          contractVersion: "tasq.command-problem.v1",
          ok: false,
          command,
          code,
          summary: message,
          exitCode,
        });
      }
      return exitCode;
    }
    printError(String(err));
    if (args.bool("json", "j")) {
      printJson({
        contractVersion: "tasq.command-problem.v1",
        ok: false,
        command,
        code: "refused",
        summary: String(err),
        exitCode: 1,
      });
    }
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
    const code = await runWithRetry(argv, clock, executable);
    if (code !== 0) {
      if (argv[0] !== "feedback") tryRecordLastFailure(argv, code, clock);
      printCaptureSuggestion(argv, executable, code);
    }
    return code;
  } catch (err) {
    if (argv[0] === "onboard" && argv.some((value) => value === "--json" || value === "-j" || value.startsWith("--json="))) {
      return printOnboardProblem(err, executable);
    }
    printError(errorMessage(err));
    if (argv[0] !== "feedback") tryRecordLastFailure(argv, 1, clock);
    printCaptureSuggestion(argv, executable, 1);
    return 1;
  }
}

/** Failure context is useful but can never replace the command's real error. */
function tryRecordLastFailure(argv: string[], exitCode: number, clock: Clock): void {
  try {
    recordLastFailure(argv, exitCode, clock);
  } catch {
    // An unwritable/unsafe TASQ_HOME is often the failure being reported.
    // Preserve that primary exit and message instead of recursively failing.
  }
}

const TASK_TARGET_COMMANDS = new Set([
  "show", "inspect", "update", "start", "done", "complete", "block", "unblock",
  "cancel", "reopen", "delete", "rm", "restore", "depend", "undepend", "claim", "release",
  "why", "resume",
]);

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

/**
 * The name a person has, not the path this build happens to live at.
 *
 * The suggestion below is meant to be copy-pasted, and printing the resolved
 * executable pasted the VERSIONED internal layout instead:
 * `/Users/x/.local/lib/tasq/0.4.0/darwin-arm64/index.js`. It exposes a private
 * path, and it stops working the moment the version changes - which is
 * guaranteed, because the whole point of the managed symlink is that the
 * version behind it moves.
 *
 * The onboard RECIPES are the opposite case and deliberately keep the absolute
 * path: an agent is told to execute the returned vector verbatim, and a name
 * on PATH is a name the host may resolve to something else.
 */
function invocationName(executable: string): string {
  const base = executable.split("/").pop() ?? executable;
  // A bundled build is `index.js` behind a `tasq` symlink; a source checkout is
  // `index.ts`. Neither is what a person types.
  return base.startsWith("index.") ? "tasq" : base;
}

/** Print an executable, secret-free follow-up capture when task work refuses. */
export function printCaptureSuggestion(argv: string[], executable: string, exitCode: number): void {
  const command = argv[0];
  if (!command || command === "capture" || !TASK_TARGET_COMMANDS.has(command)) return;
  const parsed = parseArgs(argv.slice(1));
  const taskId = parsed.positional[0];
  if (!taskId) return;
  const title = `Follow up after tasq ${command} was refused`;
  const context = JSON.stringify({ triggerCommand: command, exitCode });
  const suggestion = [
    invocationName(executable),
    "capture",
    taskId,
    title,
    "--source",
    command,
    "--context",
    context,
  ].map(shellQuote).join(" ");
  printError(`capture discovered work without leaving this task:\n  ${suggestion}`);
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  // Let stdout/stderr drain before the runtime exits. Calling process.exit()
  // can truncate a valid large JSON contract at the OS pipe-buffer boundary.
  process.exitCode = await runTasqCli(argv, systemClock, process.argv[1] ?? "tasq");
}
