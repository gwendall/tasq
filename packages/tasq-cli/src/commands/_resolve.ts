/**
 * Shared CLI helpers for resolving entity ids from short prefixes.
 *
 * UUIDv7 prefixes encode a millisecond timestamp, so two entities created in
 * the same millisecond share their first 8 chars — short prefixes are
 * ergonomic but can legitimately collide. The lookup distinguishes
 * "not found" from "ambiguous" so callers can surface the full candidate
 * ids and let the user disambiguate with a longer prefix.
 */

import {
  getGoal,
  getProject,
  getTask,
  listGoals,
  listProjects,
  listTasks,
} from "@tasq-internal/local-service";
import type { openRuntime } from "../runtime.js";
import { printError } from "../output/format.js";

type Runtime = Awaited<ReturnType<typeof openRuntime>>;

export type IdLookup =
  | { kind: "found"; id: string }
  | { kind: "not_found" }
  | { kind: "ambiguous"; matches: string[] };

interface EntityResolver {
  getById: (rt: Runtime, id: string) => Promise<{ id: string } | null>;
  listAll: (rt: Runtime) => Promise<{ id: string }[]>;
}

async function resolve(
  rt: Runtime,
  idOrShort: string,
  resolver: EntityResolver,
): Promise<IdLookup> {
  if (idOrShort.length === 36) {
    const e = await resolver.getById(rt, idOrShort);
    return e ? { kind: "found", id: e.id } : { kind: "not_found" };
  }
  if (idOrShort.length >= 4 && idOrShort.length <= 35) {
    const all = await resolver.listAll(rt);
    const matches = all.filter((e) => e.id.startsWith(idOrShort));
    if (matches.length === 1) return { kind: "found", id: matches[0]!.id };
    if (matches.length > 1) return { kind: "ambiguous", matches: matches.map((m) => m.id) };
  }
  return { kind: "not_found" };
}

const taskResolver: EntityResolver = {
  getById: (rt, id) => getTask(rt.db, id, rt.config.tenantId),
  listAll: (rt) => listTasks(rt.db, { tenantId: rt.config.tenantId, limit: 1000 }),
};

const goalResolver: EntityResolver = {
  getById: (rt, id) => getGoal(rt.db, id, rt.config.tenantId),
  listAll: (rt) => listGoals(rt.db, { tenantId: rt.config.tenantId }),
};

const projectResolver: EntityResolver = {
  getById: (rt, id) => getProject(rt.db, id, rt.config.tenantId),
  listAll: (rt) => listProjects(rt.db, { tenantId: rt.config.tenantId }),
};

export const resolveTaskId = (rt: Runtime, idOrShort: string) =>
  resolve(rt, idOrShort, taskResolver);
export const resolveGoalId = (rt: Runtime, idOrShort: string) =>
  resolve(rt, idOrShort, goalResolver);
export const resolveProjectId = (rt: Runtime, idOrShort: string) =>
  resolve(rt, idOrShort, projectResolver);

function reportError(label: string, idOrShort: string, result: IdLookup): null {
  if (result.kind === "ambiguous") {
    printError(`ambiguous ${label} id prefix '${idOrShort}' (${result.matches.length} matches):`);
    for (const m of result.matches) printError(`  ${m}`);
    printError(`use a longer prefix to disambiguate`);
  } else {
    printError(`${label} not found: ${idOrShort}`);
  }
  return null;
}

export async function resolveTaskIdOrError(
  rt: Runtime,
  idOrShort: string,
  label = "task",
): Promise<string | null> {
  const result = await resolveTaskId(rt, idOrShort);
  return result.kind === "found" ? result.id : reportError(label, idOrShort, result);
}

export async function resolveGoalIdOrError(
  rt: Runtime,
  idOrShort: string,
  label = "goal",
): Promise<string | null> {
  const result = await resolveGoalId(rt, idOrShort);
  return result.kind === "found" ? result.id : reportError(label, idOrShort, result);
}

export async function resolveProjectIdOrError(
  rt: Runtime,
  idOrShort: string,
  label = "project",
): Promise<string | null> {
  const result = await resolveProjectId(rt, idOrShort);
  return result.kind === "found" ? result.id : reportError(label, idOrShort, result);
}
