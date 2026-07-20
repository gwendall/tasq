import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  configPath,
  defaultDbPath,
  getConfigField,
  isConfigKey,
  loadConfig,
  saveConfig,
  setConfigField,
  CONFIG_KEYS,
} from "../config.js";
import { openRuntime } from "../runtime.js";
import { color, printError, printInfo, printJson } from "../output/format.js";
import type { ParsedArgs } from "../args.js";

export async function init(args: ParsedArgs): Promise<number> {
  const json = args.bool("json", "j");

  // Projection is an optional profile/surface choice. Universal setup never
  // guesses it from a repository name, HOME layout or other device state.
  const projectionTarget = args.string("projection");

  const cfg = loadConfig();
  cfg.dbPath = args.string("db") ?? cfg.dbPath ?? defaultDbPath();
  cfg.projectionTarget = projectionTarget ?? cfg.projectionTarget;
  cfg.tenantId = args.string("tenant") ?? cfg.tenantId;

  mkdirSync(dirname(cfg.dbPath), { recursive: true });
  saveConfig(cfg);

  const rt = await openRuntime();
  await rt.close();

  if (json) {
    printJson({
      ok: true,
      configPath: configPath(),
      dbPath: cfg.dbPath,
      projectionTarget: cfg.projectionTarget ?? null,
      tenantId: cfg.tenantId,
    });
  } else {
    printInfo(color.green("✓") + ` tasq initialized`);
    printInfo(`  config:     ${configPath()}`);
    printInfo(`  database:   ${cfg.dbPath}`);
    if (cfg.projectionTarget) {
      printInfo(`  projection: ${cfg.projectionTarget}`);
    } else {
      printInfo(color.dim(`  projection: (not set — run \`tasq config set projectionTarget <path>\`)`));
    }
    printInfo(`  tenant:     ${cfg.tenantId}`);
  }
  return 0;
}

export async function configCmd(args: ParsedArgs): Promise<number> {
  const [sub, key, ...rest] = args.positional;
  // Note: invoked as `config show`, `config get <k>`, `config set <k> <v>`
  // After our index.ts fix, positional[0] is the sub (correct for area/goal/event
  // which use `[sub] = positional`). For config, same pattern works.
  const json = args.bool("json", "j");

  if (!sub || sub === "show") {
    const cfg = loadConfig();
    if (json) {
      printJson(cfg);
    } else {
      printInfo(JSON.stringify(cfg, null, 2));
    }
    return 0;
  }

  if (sub === "get") {
    if (!key) {
      printError("config get <key>");
      return 1;
    }
    if (!isConfigKey(key)) {
      printError(`unknown config key: ${key}. Known: ${CONFIG_KEYS.join(", ")}`);
      return 1;
    }
    const value = getConfigField(loadConfig(), key);
    if (json) {
      printJson({ [key]: value ?? null });
    } else {
      printInfo(value ?? "");
    }
    return 0;
  }

  if (sub === "set") {
    if (!key || rest.length === 0) {
      printError("config set <key> <value>");
      return 1;
    }
    if (!isConfigKey(key)) {
      printError(`unknown config key: ${key}. Known: ${CONFIG_KEYS.join(", ")}`);
      return 1;
    }
    const value = rest.join(" ");
    const next = setConfigField(loadConfig(), key, value);
    saveConfig(next);
    if (json) {
      printJson({ ok: true, [key]: value });
    } else {
      printInfo(color.green("✓") + ` ${key} = ${value}`);
    }
    return 0;
  }

  printError(`unknown config subcommand: ${sub}`);
  return 1;
}
