import { CoordinationSpaceId } from "@tasq-run/schema";
import type { ParsedArgs } from "../args.js";
import {
  bindDirectorySpace,
  canonicalDirectory,
  configPath,
  loadConfig,
  resolveEffectiveSpace,
  saveConfig,
} from "../config.js";
import { printInfo, printJson } from "../output/format.js";

export async function useCmd(args: ParsedArgs): Promise<number> {
  const clear = args.bool("clear");
  const json = args.bool("json", "j");
  if (clear && args.positional.length > 0) {
    throw new Error("use --clear does not accept a space");
  }
  if (args.positional.length > 1) throw new Error("use accepts at most one space");

  const current = loadConfig();
  if (clear || args.positional.length === 1) {
    const space = clear ? null : CoordinationSpaceId.parse(args.positional[0]);
    const bound = bindDirectorySpace(current, process.cwd(), space);
    if (bound.changed) saveConfig(bound.config);
    const effective = resolveEffectiveSpace({
      config: bound.config,
      explicit: args.string("tenant"),
      environment: process.env.TASQ_TENANT,
      directory: bound.directory,
    });
    const result = {
      contractVersion: "tasq.directory-space-selection.v1",
      action: clear ? "cleared" : "bound",
      changed: bound.changed,
      directory: bound.directory,
      binding: space,
      effective,
      globalDefault: bound.config.tenantId,
      configPath: configPath(),
    };
    if (json) printJson(result);
    else {
      const summary = clear
        ? `Cleared Tasq space binding for ${bound.directory}.`
        : `Using Tasq space ${space} in ${bound.directory} and its descendants.`;
      printInfo(`${summary}\nEffective space: ${effective.space} (${effective.source}).\nGlobal default unchanged: ${bound.config.tenantId}.`);
    }
    return 0;
  }

  const effective = resolveEffectiveSpace({
    config: current,
    explicit: args.string("tenant"),
    environment: process.env.TASQ_TENANT,
  });
  const result = {
    contractVersion: "tasq.directory-space-selection.v1",
    action: "show",
    directory: canonicalDirectory(),
    effective,
    globalDefault: current.tenantId,
    configPath: configPath(),
  };
  if (json) printJson(result);
  else printInfo(`${effective.space}\nsource: ${effective.source}${effective.directory ? ` (${effective.directory})` : ""}`);
  return 0;
}
