/**
 * The configuration half of `tasq doctor`.
 *
 * `doctor` inspected the store, the journal and the outbox, and never the
 * private config that decides WHICH store a command reaches. On 2026-09-02
 * that config held two bindings to deleted scratch directories, a projection
 * target under a test's temporary directory, and no binding at all for this
 * project's own checkout while its AGENTS.md kept naming `tasq/dev`. Every
 * command either refused or wrote somewhere else, and nothing said so until a
 * person read the file. These checks say so.
 */
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { sep } from "node:path";
import {
  canonicalDirectory,
  canonicalPath,
  configDir,
  configPath,
  isInsideDirectory,
  loadConfig,
  resolveDirectoryProjection,
  resolveEffectiveSpace,
  resolveProjectionTarget,
  saveConfig,
  type EffectiveSpace,
  type TasqConfig,
} from "../config.js";
import { inspectManagedBlock } from "./use.js";

export const CONFIG_DOCTOR_CONTRACT = "tasq.config-doctor.v1" as const;

export type ConfigFindingCode =
  | "config_unreadable"
  | "binding_drift"
  | "project_not_set_up"
  | "dangling_binding"
  | "temporary_binding"
  | "default_space_unbound"
  | "projection_outside_bound_tree"
  | "global_projection_ignored_here";

export interface ConfigFinding {
  code: ConfigFindingCode;
  /** `error` fails the doctor; `warning` is reported and leaves `ok` alone. */
  severity: "error" | "warning";
  message: string;
  entityType: "directory" | "space" | "file";
  entityId: string;
  /** The command that repairs it, when one exists. */
  repair: string | null;
}

export interface ConfigDoctorReport {
  contractVersion: typeof CONFIG_DOCTOR_CONTRACT;
  ok: boolean;
  configPath: string;
  directory: string;
  effective: EffectiveSpace | null;
  managedBlock: ReturnType<typeof inspectManagedBlock>["managedBlock"];
  drift: boolean;
  bindings: { total: number; dangling: string[]; temporary: string[] };
  globalDefault: { space: string | null; boundIn: string[] };
  /** The global projection target, which renders only the global default space. */
  projectionTarget: string | null;
  /** The projection a mutation here would render to, if any. */
  projection: string | null;
  findings: ConfigFinding[];
  repairs: { prunedBindings: string[] };
}

export interface InspectConfigOptions {
  directory?: string;
  explicit?: string;
  environment?: string;
  /** Remove bindings whose directory no longer exists. */
  pruneBindings?: boolean;
}

/** A directory nobody means to keep: under the OS temporary root, or a scratchpad. */
function looksTemporary(directory: string): boolean {
  if (isInsideDirectory(canonicalPath(tmpdir()), canonicalPath(directory))) return true;
  return directory.split(sep).some((segment) => segment === "scratchpad" || segment === "scratch");
}

export function inspectConfig(options: InspectConfigOptions = {}): ConfigDoctorReport {
  const directory = canonicalDirectory(options.directory);
  const findings: ConfigFinding[] = [];
  const path = configPath();
  let config: TasqConfig;
  try {
    config = loadConfig();
  } catch (error) {
    findings.push({
      code: "config_unreadable",
      severity: "error",
      message: error instanceof Error ? error.message : String(error),
      entityType: "file",
      entityId: path,
      repair: null,
    });
    return {
      contractVersion: CONFIG_DOCTOR_CONTRACT,
      ok: false,
      configPath: path,
      directory,
      effective: null,
      managedBlock: null,
      drift: false,
      bindings: { total: 0, dangling: [], temporary: [] },
      globalDefault: { space: null, boundIn: [] },
      projectionTarget: null,
      projection: null,
      findings,
      repairs: { prunedBindings: [] },
    };
  }

  const bindings = config.directorySpaces ?? {};
  const dangling = Object.keys(bindings).filter((bound) => !existsSync(bound)).sort();
  // A throwaway ledger may bind throwaway directories: only a real home is
  // told that a scratch directory is bound to one of its spaces.
  const homeIsTemporary = looksTemporary(canonicalPath(configDir()));
  const temporary = homeIsTemporary
    ? []
    : Object.keys(bindings).filter((bound) => !dangling.includes(bound) && looksTemporary(bound)).sort();

  let prunedBindings: string[] = [];
  if (options.pruneBindings && dangling.length > 0) {
    const kept: Record<string, string> = {};
    for (const [bound, space] of Object.entries(bindings)) {
      if (!dangling.includes(bound)) kept[bound] = space;
    }
    saveConfig(
      { ...config, directorySpaces: Object.keys(kept).length > 0 ? kept : undefined },
      { command: ["doctor", "--prune-bindings"], unbind: dangling },
    );
    prunedBindings = dangling;
    config = loadConfig();
  }
  const liveBindings = config.directorySpaces ?? {};

  const effective = resolveEffectiveSpace({
    config,
    explicit: options.explicit,
    environment: options.environment,
    directory,
  });
  const inspected = inspectManagedBlock(directory, effective);
  if (inspected.drift && inspected.managedBlock) {
    const block = inspected.managedBlock;
    // A machine that has never had a config is not drifting: it has not
    // started. A fresh clone, a CI runner, a new laptop. That is a setup nudge,
    // and a doctor that failed on every fresh clone would be switched off.
    // Drift is a config that exists and does not bind what the repository
    // declares - which is what this project's own checkout looked like.
    if (!existsSync(path)) {
      findings.push({
        code: "project_not_set_up",
        severity: "warning",
        message: `${block.target} names space ${block.space}, and this machine has no Tasq config yet, so nothing here is set up`,
        entityType: "directory",
        entityId: block.directory,
        repair: `tasq setup --space ${block.space} --actor <stable-label>`,
      });
    } else {
      findings.push({
        code: "binding_drift",
        severity: "error",
        message: effective.source === "directory"
          ? `${block.target} names space ${block.space}, but this directory is bound to ${effective.space}`
          : `${block.target} names space ${block.space}, but this directory is not bound and commands would use ${effective.space || "no space at all"} (${effective.source})`,
        entityType: "directory",
        entityId: block.directory,
        repair: "tasq use --from-instructions",
      });
    }
  }

  for (const bound of Object.keys(liveBindings).filter((candidate) => !existsSync(candidate)).sort()) {
    findings.push({
      code: "dangling_binding",
      severity: "warning",
      message: `${bound} is bound to ${liveBindings[bound]} but no longer exists`,
      entityType: "directory",
      entityId: bound,
      repair: "tasq doctor --prune-bindings",
    });
  }
  for (const bound of temporary) {
    findings.push({
      code: "temporary_binding",
      severity: "warning",
      message: `${bound} looks like a throwaway directory and is bound to ${liveBindings[bound] ?? bindings[bound]}`,
      entityType: "directory",
      entityId: bound,
      repair: `cd ${bound} && tasq use --clear`,
    });
  }

  const boundIn = Object.entries(liveBindings)
    .filter(([, space]) => space === config.tenantId)
    .map(([bound]) => bound)
    .sort();
  // A user with one space and no bindings is never told about this: the
  // global default is their only space. It matters once other projects are
  // bound and the default points at none of them.
  if (Object.keys(liveBindings).length > 0 && boundIn.length === 0 && config.tenantId) {
    findings.push({
      code: "default_space_unbound",
      severity: "warning",
      message: `the global default ${config.tenantId} is bound to no directory, so any directory that is not bound would write to it without saying so`,
      entityType: "space",
      entityId: config.tenantId,
      repair: `tasq setup --space <the space this machine should fall back to> --default`,
    });
  }

  const projectionTarget = config.projectionTarget ?? null;
  const projection = resolveProjectionTarget(config, effective);
  // A per-directory projection is validated when it is set; only a hand-edited
  // config can point one outside its directory, and that is the one case that
  // renders a project's backlog into somebody else's file.
  for (const [bound, target] of Object.entries(config.directoryProjections ?? {}).sort()) {
    if (isInsideDirectory(bound, canonicalPath(target))) continue;
    findings.push({
      code: "projection_outside_bound_tree",
      severity: "error",
      message: `${bound} would render its projection to ${target}, outside itself`,
      entityType: "file",
      entityId: target,
      repair: `cd ${bound} && tasq use ${liveBindings[bound] ?? "<space>"} --project-to <a file inside it>`,
    });
  }
  if (
    projectionTarget
    && effective.source === "directory"
    && effective.directory
    && resolveDirectoryProjection(config, effective.directory) === null
  ) {
    findings.push({
      code: "global_projection_ignored_here",
      severity: "warning",
      message: `the global projectionTarget ${projectionTarget} renders only the global default space; commands here render no projection`,
      entityType: "directory",
      entityId: effective.directory,
      repair: `tasq use ${effective.space} --project-to <a file inside ${effective.directory}>`,
    });
  }

  return {
    contractVersion: CONFIG_DOCTOR_CONTRACT,
    ok: findings.every((finding) => finding.severity !== "error"),
    configPath: path,
    directory,
    effective,
    managedBlock: inspected.managedBlock,
    drift: inspected.drift,
    bindings: {
      total: Object.keys(liveBindings).length,
      dangling: Object.keys(liveBindings).filter((candidate) => !existsSync(candidate)).sort(),
      temporary,
    },
    globalDefault: { space: config.tenantId || null, boundIn },
    projectionTarget,
    projection,
    findings,
    repairs: { prunedBindings },
  };
}

/** Lines in the shape the doctor renderer promises: a finding, then the entity it concerns. */
export function renderConfigFindings(report: ConfigDoctorReport, dim: (text: string) => string): string[] {
  const lines: string[] = [];
  for (const finding of report.findings) {
    lines.push(`  - ${finding.code}: ${finding.message}`);
    lines.push(`      ${dim(`${finding.entityType} ${finding.entityId}`)}`);
    if (finding.repair) lines.push(`      ${dim(`repair with: ${finding.repair}`)}`);
  }
  for (const pruned of report.repairs.prunedBindings) {
    lines.push(`  - binding pruned: ${pruned}`);
  }
  return lines;
}
