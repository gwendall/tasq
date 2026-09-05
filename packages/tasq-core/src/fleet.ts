import { LEGACY_DEFAULT_WORKSPACE_ID } from "@tasq-run/schema";
/**
 * Who is holding what, right now.
 *
 * This is the view ADR-022 names as the product: not a graph, a table. The
 * lease is what makes it possible without owning a single process - the runtime
 * camp needs a daemon to know whether an agent is stuck, while an expiring
 * lease answers the only question that matters, does anyone still own this
 * work, and heals itself when the answer changes.
 *
 * Everything here is derived from live claims. Nothing is stored, so nothing
 * can drift.
 */

import type { Clock } from "@tasq-run/schema";
import type { TasqDb } from "./db.js";
import { activeTaskClaimMap } from "./service/agentic.js";
import { getTask } from "./service/tasks.js";

export interface FleetHeld {
  commitmentId: string;
  title: string;
  status: string;
  /** Milliseconds until the lease lapses. Never negative: expired leases are not live. */
  leaseRemainingMs: number;
  /** Milliseconds since the holder last renewed. */
  sinceHeartbeatMs: number;
  fence: number;
}

export interface FleetHolder {
  /** Stable grouping key for one agent in one place. */
  key: string;
  /** Client name from the MCP initialize handshake, when one was recorded. */
  client: string | null;
  clientVersion: string | null;
  /** Working directory the holder reported, when one was recorded. */
  cwd: string | null;
  pid: number | null;
  /** The actor label, which is all the ledger has when nothing else was recorded. */
  actor: string;
  held: FleetHeld[];
}

export interface FleetView {
  contractVersion: "tasq.fleet.v1";
  observedAt: number;
  holders: FleetHolder[];
}

function attribution(metadata: unknown, key: string): Record<string, unknown> {
  const bag = (metadata ?? {}) as Record<string, unknown>;
  const value = bag[key];
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * One row per agent, with what it holds.
 *
 * Holders are grouped by client identity AND working directory, because the
 * same agent product running in two projects is two things a human needs to
 * tell apart. When nothing was recorded - a CLI claim, or an MCP client that
 * sent no clientInfo - the actor label is the group, which is honest about
 * being all the ledger knows.
 */
export async function buildFleetView(
  db: TasqDb,
  tenantId = LEGACY_DEFAULT_WORKSPACE_ID,
  nowOrClock: number | Clock = Date.now(),
): Promise<FleetView> {
  const now = typeof nowOrClock === "number" ? nowOrClock : nowOrClock.now();
  const claims = await activeTaskClaimMap(db, tenantId, now);

  const holders = new Map<string, FleetHolder>();
  for (const claim of claims.values()) {
    const client = attribution(claim.metadata, "tasq.client");
    const runtime = attribution(claim.metadata, "tasq.runtime");
    const name = text(client["name"]);
    const cwd = text(runtime["cwd"]);
    const key = [name ?? `actor:${claim.actor}`, cwd ?? ""].join(" ");

    let holder = holders.get(key);
    if (!holder) {
      holder = {
        key,
        client: name,
        clientVersion: text(client["version"]),
        cwd,
        pid: typeof runtime["pid"] === "number" ? runtime["pid"] : null,
        actor: claim.actor,
        held: [],
      };
      holders.set(key, holder);
    }

    const task = await getTask(db, claim.taskId, tenantId);
    holder.held.push({
      commitmentId: claim.taskId,
      title: task?.title ?? "(unreadable commitment)",
      status: task?.status ?? "unknown",
      leaseRemainingMs: Math.max(0, claim.expiresAt - now),
      sinceHeartbeatMs: Math.max(0, now - claim.heartbeatAt),
      fence: claim.fence,
    });
  }

  for (const holder of holders.values()) {
    // Soonest to lapse first: that is the row a human acts on.
    holder.held.sort((left, right) => left.leaseRemainingMs - right.leaseRemainingMs);
  }

  return {
    contractVersion: "tasq.fleet.v1",
    observedAt: now,
    holders: [...holders.values()].sort((left, right) => {
      const byClient = (left.client ?? left.actor).localeCompare(right.client ?? right.actor);
      return byClient !== 0 ? byClient : (left.cwd ?? "").localeCompare(right.cwd ?? "");
    }),
  };
}
