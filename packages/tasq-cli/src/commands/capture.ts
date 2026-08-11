/** `tasq capture` — explicitly file local work discovered mid-task. */

import { captureDiscovery } from "@tasq-internal/local-service";
import type { Clock } from "@tasq-run/schema";
import type { ParsedArgs } from "../args.js";
import { color, printError, printInfo, printJson, shortId } from "../output/format.js";
import { openRuntime, regenerateProjection } from "../runtime.js";
import { resolveTaskIdOrError } from "./_resolve.js";
import { CAPTURE_USAGE } from "./usage.js";

function parseContext(raw: string | undefined): Record<string, unknown> {
  if (raw === undefined) return {};
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Invalid JSON for --context");
  }
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error("--context must be a JSON object");
  }
  return value as Record<string, unknown>;
}

export async function captureCmd(args: ParsedArgs, clock: Clock): Promise<number> {
  const [sourceRaw, ...titleParts] = args.positional;
  const title = titleParts.join(" ").trim();
  if (!sourceRaw || !title) {
    printError(CAPTURE_USAGE);
    return 1;
  }
  const rt = await openRuntime(args.string("actor"), args.string("tenant"), clock);
  try {
    const sourceTaskId = await resolveTaskIdOrError(rt, sourceRaw, "discovering task");
    if (!sourceTaskId) return 1;
    const result = await captureDiscovery(rt.db, {
      sourceTaskId,
      title,
      nextAction: args.string("next") ?? null,
      sourceCommand: args.string("source") ?? null,
      context: parseContext(args.string("context")),
    }, { ...rt.ctx, idempotencyKey: args.string("idempotency-key") });
    await regenerateProjection(rt);
    if (args.bool("json", "j")) {
      printJson({ contractVersion: "tasq.discovery-capture.v1", ...result });
    } else {
      printInfo(
        color.green("✓") + ` discovery captured ${color.dim(shortId(result.task.id))}` +
        `  ${result.task.title} ${color.dim(`-[discovered_from]-> ${shortId(sourceTaskId)}`)}`,
      );
    }
    return 0;
  } finally {
    await rt.close();
  }
}
