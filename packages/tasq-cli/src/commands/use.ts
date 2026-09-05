import { CoordinationSpaceId } from "@tasq-run/schema";
import type { ParsedArgs } from "../args.js";
import {
  bindDirectorySpace,
  canonicalDirectory,
  configPath,
  loadConfig,
  resolveEffectiveSpace,
  saveConfig,
  type EffectiveSpace,
} from "../config.js";
import { color, printInfo, printJson } from "../output/format.js";
import { findManagedBlock, type ManagedBlockLocation } from "./agent-instructions.js";

export const DIRECTORY_SPACE_SELECTION_CONTRACT = "tasq.directory-space-selection.v1" as const;

interface ManagedBlockReport extends ManagedBlockLocation {
  /** True when commands here would use exactly the space the block names. */
  matchesEffective: boolean;
}

/**
 * Compare what the repository declares with what commands would actually do.
 *
 * The managed block in AGENTS.md is digest-bound, so its TEXT cannot drift
 * unnoticed. Its BINDING can: the block named `tasq/dev` for this project's own
 * checkout while `tasq use` answered another space from the global default,
 * because the private config had been rewritten and nothing compared the two.
 * `drift` is that comparison. An explicit `--tenant` or `TASQ_TENANT` is a
 * deliberate override and is never reported as drift.
 */
export function inspectManagedBlock(
  directory: string,
  effective: EffectiveSpace,
): { managedBlock: ManagedBlockReport | null; drift: boolean } {
  const found = findManagedBlock(directory);
  if (!found) return { managedBlock: null, drift: false };
  const declared = found.verified && found.space !== null;
  const matchesEffective = declared && effective.source === "directory" && effective.space === found.space;
  const overridden = effective.source === "explicit_flag" || effective.source === "environment";
  return {
    managedBlock: { ...found, directory: canonicalDirectory(found.directory), matchesEffective },
    drift: declared && !matchesEffective && !overridden,
  };
}

function driftAdvice(report: ManagedBlockReport, effective: EffectiveSpace): string {
  return `${color.yellow("!")} ${report.target} names space ${report.space}, but commands here would use `
    + `${effective.space} (${effective.source}).\n  Bind this project as its repository declares: tasq use --from-instructions`;
}

export async function useCmd(args: ParsedArgs): Promise<number> {
  const clear = args.bool("clear");
  const fromInstructions = args.bool("from-instructions");
  const json = args.bool("json", "j");
  if (clear && args.positional.length > 0) {
    throw new Error("use --clear does not accept a space");
  }
  if (fromInstructions && (clear || args.positional.length > 0)) {
    throw new Error("use --from-instructions takes the space from AGENTS.md; pass neither a space nor --clear");
  }
  if (args.positional.length > 1) throw new Error("use accepts at most one space");
  const current = loadConfig();

  if (fromInstructions) {
    const found = findManagedBlock(process.cwd());
    if (!found || !found.verified || found.space === null) {
      const where = canonicalDirectory();
      const detail = found?.reason ? ` (${found.target}: ${found.reason})` : "";
      throw new Error(
        `No verified Tasq managed block found in AGENTS.md from ${where} up to the filesystem root${detail}.\n`
        + "Set the project up instead: tasq setup --space <id> --actor <label>",
      );
    }
    const bound = bindDirectorySpace(current, found.directory, found.space);
    if (bound.changed) saveConfig(bound.config, { command: ["use", "--from-instructions"] });
    const effective = resolveEffectiveSpace({
      config: bound.config,
      explicit: args.string("tenant"),
      environment: process.env.TASQ_TENANT,
      directory: bound.directory,
    });
    const inspected = inspectManagedBlock(bound.directory, effective);
    const result = {
      contractVersion: DIRECTORY_SPACE_SELECTION_CONTRACT,
      action: "bound",
      changed: bound.changed,
      directory: bound.directory,
      binding: found.space,
      restoredFrom: { target: found.target, space: found.space },
      effective,
      globalDefault: bound.config.tenantId,
      configPath: configPath(),
      ...inspected,
    };
    if (json) printJson(result);
    else {
      printInfo(
        `${bound.changed ? "Bound" : "Already bound:"} ${bound.directory} and its descendants to Tasq space `
        + `${found.space}, as ${found.target} declares.\nEffective space: ${effective.space} (${effective.source}).`,
      );
    }
    return 0;
  }

  if (clear || args.positional.length === 1) {
    const space = clear ? null : CoordinationSpaceId.parse(args.positional[0]);
    const bound = bindDirectorySpace(current, process.cwd(), space);
    if (bound.changed) {
      saveConfig(bound.config, {
        command: clear ? ["use", "--clear"] : ["use"],
        unbind: clear ? [bound.directory] : [],
      });
    }
    const effective = resolveEffectiveSpace({
      config: bound.config,
      explicit: args.string("tenant"),
      environment: process.env.TASQ_TENANT,
      directory: bound.directory,
    });
    const inspected = inspectManagedBlock(bound.directory, effective);
    const result = {
      contractVersion: DIRECTORY_SPACE_SELECTION_CONTRACT,
      action: clear ? "cleared" : "bound",
      changed: bound.changed,
      directory: bound.directory,
      binding: space,
      effective,
      globalDefault: bound.config.tenantId,
      configPath: configPath(),
      ...inspected,
    };
    if (json) printJson(result);
    else {
      const summary = clear
        ? `Cleared Tasq space binding for ${bound.directory}.`
        : `Using Tasq space ${space} in ${bound.directory} and its descendants.`;
      const lines = [
        `${summary}\nEffective space: ${effective.space} (${effective.source}).\nGlobal default unchanged: ${bound.config.tenantId}.`,
      ];
      if (inspected.drift && inspected.managedBlock) lines.push(driftAdvice(inspected.managedBlock, effective));
      printInfo(lines.join("\n"));
    }
    return 0;
  }

  const effective = resolveEffectiveSpace({
    config: current,
    explicit: args.string("tenant"),
    environment: process.env.TASQ_TENANT,
  });
  const directory = canonicalDirectory();
  const inspected = inspectManagedBlock(directory, effective);
  const result = {
    contractVersion: DIRECTORY_SPACE_SELECTION_CONTRACT,
    action: "show",
    directory,
    effective,
    globalDefault: current.tenantId,
    configPath: configPath(),
    ...inspected,
  };
  if (json) printJson(result);
  else {
    const lines = [`${effective.space}\nsource: ${effective.source}${effective.directory ? ` (${effective.directory})` : ""}`];
    if (inspected.drift && inspected.managedBlock) lines.push(driftAdvice(inspected.managedBlock, effective));
    printInfo(lines.join("\n"));
  }
  return 0;
}
