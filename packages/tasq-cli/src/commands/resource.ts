/** Explicit, machine-first generic resource coordination commands. */

import {
  BootstrapActorAlias,
  CoordinationSpaceId,
  ResourceKey,
  ResourceProblem,
  acquireResourceLease,
  getResourceLeaseView,
  listResourceEvents,
  listResourceWorld,
  releaseResourceLease,
  renewResourceLease,
  ResourceLeaseError,
  sweepExpiredResources,
  verifyResourceFence,
  type Metadata,
  type ResourceLeaseView,
  type ResourceProblemCode,
  systemClock,
  type Clock,
} from "@tasq-internal/local-service";
import type { ParsedArgs } from "../args.js";
import { color, printInfo, printJson } from "../output/format.js";
import { openRuntime } from "../runtime.js";
import { RESOURCE_USAGE } from "./usage.js";

function parseDuration(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const match = /^(\d+)(ms|s|m|h|d)$/.exec(raw);
  if (!match) throw new Error(`Invalid duration: ${raw} (expected e.g. 30m, 2h, 1d)`);
  const amount = Number(match[1]);
  const unit = match[2];
  const multiplier = unit === "ms" ? 1 : unit === "s" ? 1_000 :
    unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
  const result = amount * multiplier;
  if (!Number.isSafeInteger(result)) throw new Error(`Duration exceeds safe integer range: ${raw}`);
  return result;
}

function parseMetadata(raw: string | undefined): Metadata {
  if (raw === undefined) return {};
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("--metadata must be valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("--metadata must be a JSON object");
  }
  return value as Metadata;
}

function positive(args: ParsedArgs, name: string): number {
  const value = args.number(name);
  if (value === undefined) throw new Error(`Missing required --${name} <positive-integer>`);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`--${name} must be a positive integer`);
  return value;
}

function required(args: ParsedArgs, name: string): string {
  const value = args.string(name);
  if (!value) throw new Error(`Missing required --${name} <value>`);
  return value;
}

function explicitScope(args: ParsedArgs) {
  const workspaceId = args.string("tenant") ?? process.env.TASQ_TENANT;
  const actor = args.string("actor") ?? process.env.TASQ_ACTOR;
  if (!workspaceId) {
    throw new Error("Missing required --tenant <space>; resource coordination never guesses a space from config, HOME or cwd");
  }
  if (!actor) {
    throw new Error("Missing required --actor <stable-label>; resource coordination never guesses identity from config, HOME or cwd");
  }
  return {
    workspaceId: CoordinationSpaceId.parse(workspaceId),
    actor: BootstrapActorAlias.parse(actor),
  };
}

function retryTemplate(workspaceId: string, actor: string, resourceKey: string) {
  return [
    "tasq", "resource", "acquire", resourceKey,
    "--tenant", workspaceId,
    "--actor", actor,
    "--idempotency-key", "{newIdempotencyKey}",
    "--json",
  ];
}

function problemFor(
  error: unknown,
  workspaceId: string | null,
  actor: string | null,
  resourceKey: string | null,
) {
  const message = [...(error instanceof Error ? error.message : String(error))].slice(0, 2_000).join("") || "Unknown resource failure";
  const leaseError = error instanceof ResourceLeaseError ? error : null;
  const isInput = error instanceof Error && error.name === "ZodError" ||
    /^(Missing|required|Unexpected|Unknown flag|Invalid|--)/i.test(message);
  const isStorage = /database|disk|permission|SQLITE|readonly|read-only/i.test(message);
  const code: ResourceProblemCode = leaseError?.code ?? (isInput ? "invalid_input" : isStorage ? "storage_error" : "unavailable");
  const currentLease: ResourceLeaseView | null = leaseError?.currentLease ?? null;
  const nextActions: Array<{
    kind: "inspect" | "wait_until" | "retry" | "choose_alternative" | "help";
    description: string;
    notBefore?: number;
    argvTemplate?: string[];
  }> = [];
  if (workspaceId && actor && resourceKey) {
    nextActions.push({
      kind: "inspect",
      description: "Inspect the current lease before deciding what to do.",
      argvTemplate: ["tasq", "resource", "get", resourceKey, "--tenant", workspaceId, "--actor", actor, "--json"],
    });
  }
  if (code === "contended" && currentLease) {
    nextActions.push({
      kind: "wait_until",
      description: `Wait until the current lease expires at ${currentLease.lease.expiresAt}, then retry acquisition.`,
      notBefore: currentLease.lease.expiresAt,
    });
    if (workspaceId && actor && resourceKey) {
      nextActions.push({
        kind: "retry",
        description: "Retry with a fresh idempotency key after the indicated expiry.",
        argvTemplate: retryTemplate(workspaceId, actor, resourceKey),
      });
    }
    nextActions.push({
      kind: "choose_alternative",
      description: "Choose a different resource key if the work can proceed independently.",
    });
  }
  if (nextActions.length === 0) {
    nextActions.push({
      kind: "help",
      description: "Read the exact generic resource command syntax.",
      argvTemplate: ["tasq", "resource", "--help"],
    });
  }
  return ResourceProblem.parse({
    contractVersion: "tasq.resource-problem.v1",
    status: "error",
    code,
    message,
    retryable: code === "contended" || code === "storage_error" && /BUSY|locked|temporar/i.test(message),
    workspaceId,
    resourceKey,
    currentLease,
    nextActions,
  });
}

function errorExit(problem: ReturnType<typeof problemFor>): number {
  if (problem.code === "invalid_input") return 2;
  if (problem.code === "storage_error") return 3;
  return 1;
}

export async function resourceCmd(
  args: ParsedArgs,
  clock: Clock = systemClock,
  busyAttempt = 1,
): Promise<number> {
  const jsonRequested = args.flag("json", "j") !== undefined;
  let json = false;
  let workspaceId: string | null = null;
  let actor: string | null = null;
  let resourceKey: string | null = null;
  try {
    json = args.bool("json", "j");
    args.assertKnown([
      "json", "j", "actor", "tenant", "help", "h", "lease", "fence", "revision",
      "idempotency-key", "for", "metadata", "reason", "active-only", "holder",
      "limit", "after-sequence",
    ]);
    const scope = explicitScope(args);
    workspaceId = scope.workspaceId;
    actor = scope.actor;
    const [sub, rawKey, ...extra] = args.positional;
    if (!sub || extra.length > 0) throw new Error(RESOURCE_USAGE);
    if (!["list", "events", "sweep"].includes(sub) && !rawKey) throw new Error(RESOURCE_USAGE);
    if (["list", "sweep"].includes(sub) && rawKey) throw new Error(`Unexpected positional argument for resource ${sub}: ${rawKey}`);
    resourceKey = rawKey ? ResourceKey.parse(rawKey) : null;

    const rt = await openRuntime(actor, workspaceId, clock);
    try {
      const context = { workspaceId, actor, clock: rt.ctx.clock };
      let result: unknown;
      if (sub === "acquire") {
        result = await acquireResourceLease(rt.db, resourceKey!, {
          ...context,
          idempotencyKey: required(args, "idempotency-key"),
          leaseMs: parseDuration(args.string("for")),
          metadata: parseMetadata(args.string("metadata")),
        });
      } else if (sub === "renew") {
        result = await renewResourceLease(rt.db, resourceKey!, {
          ...context,
          idempotencyKey: required(args, "idempotency-key"),
          leaseId: required(args, "lease"),
          fence: positive(args, "fence"),
          expectedRevision: positive(args, "revision"),
          leaseMs: parseDuration(args.string("for")),
        });
      } else if (sub === "release") {
        result = await releaseResourceLease(rt.db, resourceKey!, {
          ...context,
          idempotencyKey: required(args, "idempotency-key"),
          leaseId: required(args, "lease"),
          fence: positive(args, "fence"),
          expectedRevision: positive(args, "revision"),
          reason: args.string("reason"),
        });
      } else if (sub === "verify") {
        result = await verifyResourceFence(rt.db, resourceKey!, {
          ...context,
          leaseId: required(args, "lease"),
          fence: positive(args, "fence"),
        });
      } else if (sub === "get") {
        result = await getResourceLeaseView(rt.db, resourceKey!, context);
        if (!result) throw new ResourceLeaseError("not_found", `No lease history for ${resourceKey}`);
      } else if (sub === "list") {
        result = await listResourceWorld(rt.db, {
          ...context,
          activeOnly: args.bool("active-only"),
          holderPrincipalId: args.string("holder"),
          limit: args.number("limit"),
        });
      } else if (sub === "events") {
        result = await listResourceEvents(rt.db, {
          ...context,
          resourceKey: resourceKey ?? undefined,
          afterSequence: args.number("after-sequence"),
          limit: args.number("limit"),
        });
      } else if (sub === "sweep") {
        result = await sweepExpiredResources(rt.db, { ...context, limit: args.number("limit") });
      } else {
        throw new Error(`Unknown resource subcommand: ${sub}`);
      }
      if (json) printJson(result);
      else if (sub === "list" || sub === "events") printInfo(JSON.stringify(result, null, 2));
      else printInfo(`${color.green("✓")} resource ${sub} ${resourceKey ?? workspaceId}`);
      return 0;
    } finally {
      await rt.close();
    }
  } catch (error) {
    // Every resource mutation has a mandatory durable idempotency key and
    // compare-and-swap authority. Replaying the complete one-shot command is
    // therefore safe after SQLite contention, including the lost-response
    // boundary where the first attempt committed. Reads are naturally safe.
    // Keep this retry inside the resource surface so the final failure still
    // uses its stdout-only typed problem contract.
    if (/SQLITE_BUSY|database is locked/i.test(error instanceof Error ? error.message : String(error)) && busyAttempt < 5) {
      const delay = 25 * 2 ** (busyAttempt - 1);
      await new Promise((resolve) => setTimeout(resolve, delay));
      return resourceCmd(args, clock, busyAttempt + 1);
    }
    if (!jsonRequested) throw error;
    const problem = problemFor(error, workspaceId, actor, resourceKey);
    printJson(problem);
    return errorExit(problem);
  }
}
