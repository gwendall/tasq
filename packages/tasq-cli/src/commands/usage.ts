/**
 * Per-command usage strings — single source of truth.
 *
 * Each value is the one-line (or short multi-line) usage shown both by the
 * `--help` / `help <cmd>` intercept in index.ts AND by a command's own
 * missing-arg `printError(...)` path, so the two can never drift.
 *
 * Keyed by the CLI command name as dispatched in index.ts. Grouped commands
 * (area/goal/project/event/config) carry a short multi-subcommand block that
 * mirrors the corresponding section of `printHelp()`.
 */

// ── Task verbs (top-level) ──────────────────────────────────────────────
export const ADD_USAGE =
  "add <title> [--area <slug>] [--goal <id>] [--project <id>] [--parent <task-id>] [--description <text>] [--next <text>] [--success <criteria>] [--completion assertion|evidence] [--priority 1-5] [--due <iso>] [--schedule <iso>] [--est <min>] [--recurrence daily|weekly|monthly|yearly] [--interval N] [--anchor due|scheduled|completion] [--metadata <json>] [--idempotency-key <key>]";
export const SHOW_USAGE = "show <id>";
export const INSPECT_USAGE = "inspect <id> [--json]   canonical profile-neutral commitment graph";
export const DISCOVER_USAGE = `discover [show] [--json]
discover schema <resource-id> [--json]
discover negotiate --hello <json> [--json]`;
export const UPDATE_USAGE =
  "update <id> [--title ...] [--description ...] [--next ...] [--success ...] [--completion assertion|evidence] [--priority 1-5] [--due <iso>] [--schedule <iso>] [--est <min>] [--area <slug>] [--goal <id>] [--project <id>] [--parent <id>] [--recurrence daily|weekly|monthly|yearly] [--interval N] [--anchor due|scheduled|completion] [--metadata <json>|--metadata-patch <json>] [--clear-description|--clear-next|--clear-success|--clear-priority|--clear-est|--clear-due|--clear-schedule|--clear-area|--clear-goal|--clear-project|--clear-parent|--clear-recurrence|--clear-metadata]";
export const TREE_USAGE = "tree <id> — shows a task + its sub-tasks";
export const TASK_STATUS_USAGE =
  "task status <id>  (shows progress + ETA for a task with sub-tasks)";
export const SEARCH_USAGE = 'search "<query>"';

/** transitionCmd builds its missing-arg usage from the verb name. */
export function transitionUsage(verb: string): string {
  return `${verb} <id>${verb === "done" ? " [--evidence <id,...>]" : ""} [--reason <text>] [--note <text>] [--at <iso>] [--expected-revision <n>] [--idempotency-key <key>]`;
}

export const DEPEND_USAGE =
  "depend <id> --on <other-id> [--type blocks|relates_to|duplicates]";
export const UNDEPEND_USAGE =
  "undepend <id> --on <other-id> [--type blocks|relates_to|duplicates]";

export const LIST_USAGE =
  "list [--status ...] [--area <slug>] [--goal <id>] [--project <id>] [--limit N] [--include-scheduled] [--include-deferred]";
export const INBOX_USAGE = "inbox [--limit N] [--include-scheduled] [--include-deferred] — tasks without a project";
export const NEXT_USAGE = "next [--limit N] [--area <slug>] [--goal <id>] [--project <id>] [--include-scheduled] [--include-deferred] [--include-claimed] — prioritized next-action list";
export const CONTEXT_USAGE = "context [--max-records N] [--max-tokens N] [--include-deferred] [--json] — bounded profile-neutral context packet (`brief` alias)";
export const SUMMARY_USAGE = `summary add <commitment-id> --text <text> --idempotency-key <key> [--supersedes <summary-id>]
summary list <commitment-id> [--limit N]
summary current [--limit N]
summary show <summary-id>
Terminal-only derived context; inspect/audit/evidence remain authoritative.`;
export const CONTEXT_LINK_USAGE = `context-link attach <commitment-id> --system <absolute-uri> --resource-type <type> --external-id <id> --idempotency-key <key>
                    [--url <absolute-uri>] [--version <version>] [--digest <digest>] [--purpose <absolute-uri>] [--supersedes <link-id>]
context-link detach <current-link-id> --idempotency-key <key>
context-link list <commitment-id> [--history] [--limit N]
context-link show <link-id>
Stores an append-only pointer only; external content, retrieval, credentials and authority stay outside Tasq.`;
export const PROJECTION_USAGE =
  "projection [--target <path>]   regenerate markdown projection";
export const BACKUP_USAGE =
  "backup [<path>] [--rotate N]   snapshot DB to ~/.tasq/snapshots/";
export const EXPORT_USAGE =
  "export [<path>] [--max-records N] [--max-bytes N]   bounded portable workspace export; not a recovery snapshot";
export const IMPORT_USAGE =
  "import <export.json> --db <new-db-path>   validate fully, then create a new store; never merges";
export const DOCTOR_USAGE = "doctor [--fix-permissions] [--repair-outbox]   verify/repair DB, delivery, journal and private modes";
export const JOURNAL_USAGE =
  "journal checkpoint --accept-database --reason <text> [--dry-run]   archive the current segment and accept the DB cursor baseline";
export const INIT_USAGE = "init   create ~/.tasq/db.sqlite + config";
export const ONBOARD_USAGE = "onboard --space <id> --actor <stable-label> [--capabilities read,propose,coordinate] --json";
export const RESOURCE_USAGE = `resource acquire <key> --idempotency-key <key> [--for 30m] [--metadata <json>]
resource renew <key> --lease <id> --fence <n> --revision <n> --idempotency-key <key> [--for 30m]
resource release <key> --lease <id> --fence <n> --revision <n> --idempotency-key <key> [--reason <text>]
resource verify <key> --lease <id> --fence <n>
resource get <key>
resource list [--active-only] [--holder <principal-id>] [--limit N]
resource events [key] [--after-sequence N] [--limit N]
resource sweep [--limit N]
All forms require --tenant <space> --actor <stable-label>; agents should pass --json.`;
export const MCP_USAGE = `mcp --tenant <space> --actor <stable-label> [--capabilities read,propose,coordinate]
Start a capability-scoped local MCP JSON-RPC server on stdio. Generic stdio
never grants effect dispatch authority.`;
export const WEB_USAGE = `web --tenant <space> [--host 127.0.0.1|localhost|::1] [--port 4137] [--json]
web status --tenant <space> [--json]
Start an explicit foreground, unauthenticated read-only Console on loopback, or
prove whether its registered listener is live. Port 0 selects an ephemeral port.
JSON start emits one versioned NDJSON announcement. No daemon is installed.`;
export const CLAIM_USAGE = "claim <task-id> [--for 30m|--until <iso>] [--metadata <json>] [--idempotency-key <key>] — acquire or renew a lease";
export const RELEASE_USAGE = "release <task-id> [--reason <text>] [--force]";
export const ATTEMPT_USAGE = `attempt start <task-id> [--claim <claim-id>] [--runtime <name>] [--external-id <id>] [--context-id <id>] [--metadata <json>] [--idempotency-key <key>]
attempt list [task-id]
attempt show <attempt-id>
attempt status <attempt-id> --status running|input_required|succeeded|failed|cancelled [--expected-revision <n>] [--idempotency-key <key>]
attempt succeed|fail|cancel|wait|resume <attempt-id> [--message <text>] [--expected-revision <n>] [--idempotency-key <key>]`;
export const EVIDENCE_USAGE = `evidence add <task-id> --kind <kind> [--summary <text>] [--uri <uri>] [--digest <digest>] [--source <source>] [--attempt <id>] [--supersedes <id>] [--observed-at <iso>] [--metadata <json>] [--idempotency-key <key>]
evidence list [task-id] [--kind <kind>] [--limit N]
evidence show <evidence-id>`;
export const WAIT_USAGE = `wait create <task-id> --kind <kind> --parameters <json> [--not-before <iso>] [--deadline <iso>]
            [--fallback-kind none|create_task|activate_task] [--fallback-spec <json>|--fallback-task <task-id>]
            [--schema-version N] [--supersedes <wait-id>] [--idempotency-key <key>]
wait list [task-id] [--status <status>] [--kind <kind>] [--limit N]
wait show <wait-id>
wait candidates <wait-id> [--matcher-version N]
wait cancel <wait-id> --reason <text>
wait sweep [--at <iso>] [--matcher-version N] [--limit N]`;
export const OBSERVATION_USAGE = `observation ingest --source <source> --external-event-id <id> --kind <kind>
                   --payload <json> --occurred-at <iso> [--schema-version N] [--verification-level <level>]
                   [--verification-method <method>] [--raw-ref <ref>] [--digest <digest>] [--metadata <json>]
observation list [--source <source>] [--kind <kind>] [--verification-level <level>] [--occurred-from <iso>] [--occurred-to <iso>] [--after-recorded-at <iso> --after-id <id>] [--limit N] [--ascending]
observation show <observation-id>`;
export const RECONCILE_USAGE = `reconcile <wait-id> <observation-id> [--matcher-version N]
reconcile list [wait-id] [--observation <id>] [--decision <decision>] [--effect <effect>] [--limit N] [--ascending]
reconcile show <reconciliation-id>`;

// ── Grouped commands (sub-dispatch by positional) ───────────────────────
export const AREA_USAGE = `area list                     list all areas
area show <slug>              show area details
area add <name> --slug <s> [--importance 1-5] [--cadence <text>] [--description <text>]
area update <slug> [--name ...] [--importance ...] [--cadence ...] [--description ...]
area delete <slug> [--cascade]`;

export const GOAL_USAGE = `goal list [--area <slug>] [--status active|paused|done|abandoned]
goal add <title> --area <slug> [--horizon <text>] [--importance 1-5] [--target-date <iso>]
goal update <id> [--title ...] [--status ...] [--horizon ...] [--importance ...]`;

export const PROJECT_USAGE = `project list [--status ...] [--goal <id>]
project add <title> [--goal <id>] [--area <slug>]
project update <id> [--title ...] [--status ...] [--goal <id>] [--area <slug>]
project status <id>           progress + ETA for a project`;

export const EVENT_USAGE = `event list [--since <iso>] [--before <iso>] [--entity-id <id>] [--actor <name>]
           [--entity-type area|goal|project|task] [--after-sequence N] [--before-sequence N] [--ascending] [--limit N]`;

export const CONFIG_USAGE = `config show                   print the loaded config
config get <key>              read one config field
config set <key> <value>      persist one config field`;

/**
 * Lookup keyed by the top-level command name as routed in index.ts. Aliases
 * (complete/rm) are intentionally folded onto their canonical verb. Returns
 * `undefined` for an unknown command (the caller falls back to general help).
 */
export function commandUsage(command: string): string | undefined {
  switch (command) {
    case "add":
      return ADD_USAGE;
    case "list":
      return LIST_USAGE;
    case "show":
      return SHOW_USAGE;
    case "inspect":
      return INSPECT_USAGE;
    case "discover":
      return DISCOVER_USAGE;
    case "update":
      return UPDATE_USAGE;
    case "start":
      return transitionUsage("start");
    case "done":
    case "complete":
      return transitionUsage("done");
    case "block":
      return transitionUsage("block");
    case "unblock":
      return transitionUsage("unblock");
    case "cancel":
      return transitionUsage("cancel");
    case "reopen":
      return transitionUsage("reopen");
    case "delete":
    case "rm":
      return transitionUsage("delete");
    case "restore":
      return transitionUsage("restore");
    case "next":
      return NEXT_USAGE;
    case "context":
    case "brief":
      return CONTEXT_USAGE;
    case "summary":
      return SUMMARY_USAGE;
    case "context-link":
      return CONTEXT_LINK_USAGE;
    case "search":
      return SEARCH_USAGE;
    case "inbox":
      return INBOX_USAGE;
    case "tree":
      return TREE_USAGE;
    case "task":
      return TASK_STATUS_USAGE;
    case "depend":
      return DEPEND_USAGE;
    case "undepend":
      return UNDEPEND_USAGE;
    case "event":
      return EVENT_USAGE;
    case "projection":
      return PROJECTION_USAGE;
    case "backup":
      return BACKUP_USAGE;
    case "export":
      return EXPORT_USAGE;
    case "import":
      return IMPORT_USAGE;
    case "doctor":
      return DOCTOR_USAGE;
    case "journal":
      return JOURNAL_USAGE;
    case "claim":
      return CLAIM_USAGE;
    case "release":
      return RELEASE_USAGE;
    case "attempt":
      return ATTEMPT_USAGE;
    case "evidence":
      return EVIDENCE_USAGE;
    case "wait":
      return WAIT_USAGE;
    case "observation":
      return OBSERVATION_USAGE;
    case "reconcile":
      return RECONCILE_USAGE;
    case "area":
      return AREA_USAGE;
    case "goal":
      return GOAL_USAGE;
    case "project":
      return PROJECT_USAGE;
    case "config":
      return CONFIG_USAGE;
    case "init":
      return INIT_USAGE;
    case "onboard":
      return ONBOARD_USAGE;
    case "resource":
      return RESOURCE_USAGE;
    case "mcp":
      return MCP_USAGE;
    case "web":
      return WEB_USAGE;
    default:
      return undefined;
  }
}
