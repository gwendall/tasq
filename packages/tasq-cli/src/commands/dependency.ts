/**
 * `tasq depend` / `tasq undepend` — first-class peer task dependencies (SPEC §4.5).
 *
 *   tasq depend   <id> --on <other-id> [--type blocks|relates_to|duplicates]
 *   tasq undepend <id> --on <other-id> [--type blocks|relates_to|duplicates]
 *
 * Mirrors `from --[type]-> to`: `depend A --on B` records "A depends on B".
 * For `type=blocks` that means B blocks A (A is held up until B resolves); the
 * edge is cycle-guarded and feeds the prioritizer's W_blocked down-weight. It
 * NEVER auto-flips A's status to `blocked` (SPEC §4.5 "no automatic coupling").
 *
 * NOTE: the milestone mandates the `--on`/`--type` flag form, which supersedes
 * the older SPEC §7.1 sketch `tq depend <id> blocks <other>`.
 */

import {
  dependTask,
  undependTask,
  DEPENDENCY_TYPES,
  type DependencyType,
} from "@tasq-internal/local-service";
import { openRuntime, regenerateProjection } from "../runtime.js";
import { color, printError, printInfo, printJson, shortId } from "../output/format.js";
import { enumArg, type ParsedArgs } from "../args.js";
import { resolveTaskIdOrError } from "./_resolve.js";
import { DEPEND_USAGE, UNDEPEND_USAGE } from "./usage.js";

export async function dependCmd(args: ParsedArgs): Promise<number> {
  const [id] = args.positional;
  const onRaw = args.string("on");
  if (!id || !onRaw) {
    printError(DEPEND_USAGE);
    return 1;
  }
  const type = enumArg<DependencyType>(args.string("type"), DEPENDENCY_TYPES, "type") ?? "blocks";

  const rt = await openRuntime(args.string("actor"), args.string("tenant"));
  try {
    const fromTaskId = await resolveTaskIdOrError(rt, id);
    if (!fromTaskId) return 1;
    const toTaskId = await resolveTaskIdOrError(rt, onRaw, "dependency target");
    if (!toTaskId) return 1;

    const edge = await dependTask(rt.db, { fromTaskId, toTaskId, type }, rt.ctx);
    await regenerateProjection(rt);

    if (args.bool("json", "j")) {
      printJson(edge);
    } else {
      printInfo(
        color.green("✓") +
          ` dependency added  ${color.dim(shortId(fromTaskId))} ${color.dim(`-[${type}]->`)} ${color.dim(shortId(toTaskId))}`,
      );
    }
    return 0;
  } finally {
    await rt.close();
  }
}

export async function undependCmd(args: ParsedArgs): Promise<number> {
  const [id] = args.positional;
  const onRaw = args.string("on");
  if (!id || !onRaw) {
    printError(UNDEPEND_USAGE);
    return 1;
  }
  const type = enumArg<DependencyType>(args.string("type"), DEPENDENCY_TYPES, "type") ?? "blocks";

  const rt = await openRuntime(args.string("actor"), args.string("tenant"));
  try {
    const fromTaskId = await resolveTaskIdOrError(rt, id);
    if (!fromTaskId) return 1;
    const toTaskId = await resolveTaskIdOrError(rt, onRaw, "dependency target");
    if (!toTaskId) return 1;

    await undependTask(rt.db, null, { ...rt.ctx, fromTaskId, toTaskId, type });
    await regenerateProjection(rt);

    if (args.bool("json", "j")) {
      printJson({ ok: true, fromTaskId, toTaskId, type, removed: true });
    } else {
      printInfo(
        color.green("✓") +
          ` dependency removed  ${color.dim(shortId(fromTaskId))} ${color.dim(`-[${type}]->`)} ${color.dim(shortId(toTaskId))}`,
      );
    }
    return 0;
  } finally {
    await rt.close();
  }
}
