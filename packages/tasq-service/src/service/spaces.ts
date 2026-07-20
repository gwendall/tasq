/** Explicit create-or-join lifecycle for universal coordination spaces. */

import { eq } from "drizzle-orm";
import {
  BootstrapActorAlias,
  CoordinationSpace as CoordinationSpaceZ,
  CoordinationSpaceId,
  coordinationSpace,
  type Clock,
  type CoordinationSpace,
  type Principal,
} from "@tasq/schema";
import type { TasqDb, TasqDbOrTx } from "../db.js";
import { serviceNow } from "../util/clock.js";
import { ensureLocalPrincipal } from "./principals.js";

export interface BootstrapCoordinationSpaceInput {
  workspaceId: string;
  actor: string;
  /** Required authority clock. Device time is never read in this service. */
  clock: Clock;
}

export interface BootstrapCoordinationSpaceResult {
  disposition: "created" | "joined";
  space: CoordinationSpace;
  principal: Principal;
}

function parseSpace(row: typeof coordinationSpace.$inferSelect): CoordinationSpace {
  return CoordinationSpaceZ.parse(row);
}

/**
 * Create or join a named space and establish attribution identity. The two
 * writes are intentionally independent idempotent inserts rather than a
 * deferred SQLite transaction: cross-process first joiners can otherwise
 * deadlock while upgrading concurrent read transactions to writers. A crash
 * between them can leave only a harmless principal; retry converges by
 * creating the missing space. No state can claim a space without its FK-bound
 * creator, and exact retries are safe.
 */
export async function bootstrapCoordinationSpace(
  db: TasqDb,
  input: BootstrapCoordinationSpaceInput,
): Promise<BootstrapCoordinationSpaceResult> {
  if (!input.clock || typeof input.clock.now !== "function") {
    throw new Error("clock is required for coordination space bootstrap");
  }
  const workspaceId = CoordinationSpaceId.parse(input.workspaceId);
  const actor = BootstrapActorAlias.parse(input.actor);
  const now = serviceNow({ clock: input.clock });

  const principal = await ensureLocalPrincipal(db, workspaceId, actor, now);
  const inserted = await db.insert(coordinationSpace).values({
    workspaceId,
    createdByPrincipalId: principal.id,
    createdAt: now,
  }).onConflictDoNothing().returning({ workspaceId: coordinationSpace.workspaceId });

  const rows = await db.select().from(coordinationSpace)
    .where(eq(coordinationSpace.workspaceId, workspaceId))
    .limit(1);
  if (!rows[0]) throw new Error(`Failed to read coordination space ${workspaceId}`);
  return {
    disposition: inserted.length === 1 ? "created" : "joined",
    space: parseSpace(rows[0]),
    principal,
  };
}

export async function getCoordinationSpace(
  db: TasqDbOrTx,
  workspaceIdInput: string,
): Promise<CoordinationSpace | null> {
  const workspaceId = CoordinationSpaceId.parse(workspaceIdInput);
  const rows = await db.select().from(coordinationSpace)
    .where(eq(coordinationSpace.workspaceId, workspaceId))
    .limit(1);
  return rows[0] ? parseSpace(rows[0]) : null;
}
