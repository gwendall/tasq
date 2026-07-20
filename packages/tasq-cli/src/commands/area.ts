import {
  createArea,
  getAreaBySlug,
  listAreas,
  softDeleteArea,
  updateArea,
} from "@tasq-internal/local-service";
import { openRuntime, regenerateProjection } from "../runtime.js";
import { color, printError, printInfo, printJson, shortId } from "../output/format.js";
import type { ParsedArgs } from "../args.js";

export async function areaCmd(args: ParsedArgs): Promise<number> {
  const [sub] = args.positional;
  if (!sub || sub === "list") return list(args);
  if (sub === "show") return show(args);
  if (sub === "add") return add(args);
  if (sub === "update") return update(args);
  if (sub === "delete" || sub === "rm") return remove(args);
  printError(`unknown area subcommand: ${sub}`);
  return 1;
}

async function list(args: ParsedArgs): Promise<number> {
  const json = args.bool("json", "j");
  const rt = await openRuntime(args.string("actor"), args.string("tenant"));
  try {
    const areas = await listAreas(rt.db, { tenantId: rt.config.tenantId });
    if (json) {
      printJson(areas);
    } else if (areas.length === 0) {
      printInfo(color.dim("(no areas — `tasq area add <name> --slug <slug>`)"));
    } else {
      for (const a of areas) {
        const importance = color.dim(`imp:${a.importance}`);
        const cadence = a.cadenceTarget ? color.dim(` · ${a.cadenceTarget}`) : "";
        printInfo(`${color.bold(`#${a.slug}`)}  ${a.name}  ${importance}${cadence}  ${color.dim(shortId(a.id))}`);
      }
    }
    return 0;
  } finally {
    await rt.close();
  }
}

async function show(args: ParsedArgs): Promise<number> {
  const [, slugOrId] = args.positional; // [sub, slug]
  if (!slugOrId) {
    printError("area show <slug|id>");
    return 1;
  }
  const json = args.bool("json", "j");
  const rt = await openRuntime(args.string("actor"), args.string("tenant"));
  try {
    const a = await getAreaBySlug(rt.db, slugOrId, rt.config.tenantId);
    if (!a) {
      printError(`area not found: ${slugOrId}`);
      return 1;
    }
    if (json) printJson(a);
    else printInfo(JSON.stringify(a, null, 2));
    return 0;
  } finally {
    await rt.close();
  }
}

async function add(args: ParsedArgs): Promise<number> {
  const [, ...rest] = args.positional;
  const name = rest.join(" ");
  if (!name) {
    printError("area add <name> --slug <slug> [--importance 1-5] [--cadence <text>]");
    return 1;
  }
  const slug = args.string("slug");
  if (!slug) {
    printError("--slug is required");
    return 1;
  }
  const importance = args.number("importance") ?? 3;
  const cadence = args.string("cadence");
  const description = args.string("description");
  const json = args.bool("json", "j");

  const rt = await openRuntime(args.string("actor"), args.string("tenant"));
  try {
    const a = await createArea(
      rt.db,
      {
        name,
        slug,
        importance,
        cadenceTarget: cadence ?? null,
        description: description ?? null,
      },
      rt.ctx,
    );
    await regenerateProjection(rt);
    if (json) printJson(a);
    else printInfo(color.green("✓") + ` area #${a.slug} created — ${shortId(a.id)}`);
    return 0;
  } finally {
    await rt.close();
  }
}

async function update(args: ParsedArgs): Promise<number> {
  const [, slug] = args.positional;
  if (!slug) {
    printError("area update <slug> [--name ...] [--importance ...] [--cadence ...]");
    return 1;
  }
  const rt = await openRuntime(args.string("actor"), args.string("tenant"));
  try {
    const a = await getAreaBySlug(rt.db, slug, rt.config.tenantId);
    if (!a) {
      printError(`area not found: ${slug}`);
      return 1;
    }
    const patch: Record<string, unknown> = {};
    if (args.string("name") !== undefined) patch.name = args.string("name");
    if (args.string("slug") !== undefined) patch.slug = args.string("slug");
    if (args.number("importance") !== undefined) patch.importance = args.number("importance");
    if (args.string("cadence") !== undefined) patch.cadenceTarget = args.string("cadence");
    if (args.string("description") !== undefined) patch.description = args.string("description");

    const updated = await updateArea(rt.db, a.id, patch, rt.ctx);
    await regenerateProjection(rt);
    if (args.bool("json", "j")) printJson(updated);
    else printInfo(color.green("✓") + ` area #${updated.slug} updated`);
    return 0;
  } finally {
    await rt.close();
  }
}

async function remove(args: ParsedArgs): Promise<number> {
  const [, slug] = args.positional;
  if (!slug) {
    printError("area delete <slug>");
    return 1;
  }
  const rt = await openRuntime(args.string("actor"), args.string("tenant"));
  try {
    const a = await getAreaBySlug(rt.db, slug, rt.config.tenantId);
    if (!a) {
      printError(`area not found: ${slug}`);
      return 1;
    }
    try {
      await softDeleteArea(rt.db, a.id, { ...rt.ctx, cascade: args.bool("cascade") });
    } catch (err) {
      // Block-default: live children still reference the area unless --cascade.
      printError(err instanceof Error ? err.message : String(err));
      return 1;
    }
    await regenerateProjection(rt);
    if (args.bool("json", "j")) printJson({ ok: true, id: a.id });
    else printInfo(color.green("✓") + ` area #${slug} deleted`);
    return 0;
  } finally {
    await rt.close();
  }
}
