import { createHash } from "node:crypto";
import { existsSync, lstatSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  bootstrapCoordinationSpace,
} from "@tasq-internal/local-service";
import {
  BootstrapActorAlias,
  CoordinationSpaceId,
  type Clock,
} from "@tasq-run/schema";
import type { ParsedArgs } from "../args.js";
import {
  configDir,
  defaultDbPath,
  loadConfig,
  saveConfig,
} from "../config.js";
import { printInfo, printJson } from "../output/format.js";
import { openRuntime } from "../runtime.js";

const CAPABILITIES = ["read", "propose", "coordinate"] as const;
type Capability = (typeof CAPABILITIES)[number];
type AgentHost = "codex" | "claude" | "generic";

function parseCapabilities(raw: string | undefined): Capability[] {
  const values = (raw ?? CAPABILITIES.join(","))
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const unknown = values.filter((value) => !CAPABILITIES.includes(value as Capability));
  if (values.length === 0 || unknown.length > 0 || new Set(values).size !== values.length) {
    throw new Error("--capabilities must be a unique comma-separated subset of read,propose,coordinate");
  }
  if (!values.includes("read") && values.some((value) => value !== "read")) {
    throw new Error("--capabilities must include read whenever propose or coordinate is requested");
  }
  return CAPABILITIES.filter((capability) => values.includes(capability));
}

function assertSafeHome(): void {
  const home = configDir();
  if (!existsSync(home)) return;
  const stat = lstatSync(home);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Unsafe Tasq home: ${home} must be a real directory, not a symlink or file`);
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(`Unsafe Tasq home permissions: ${home} must not be accessible by group or other users`);
  }
}

/**
 * One explicit human setup. Unlike autonomous onboarding this persists the
 * selected space and actor so subsequent human CLI verbs can stay terse.
 */
export async function setupCmd(args: ParsedArgs, clock: Clock): Promise<number> {
  const json = args.bool("json", "j");
  if (args.positional.length > 0) throw new Error("setup accepts flags only");
  const space = CoordinationSpaceId.parse(args.string("space"));
  const actor = BootstrapActorAlias.parse(args.string("actor"));
  assertSafeHome();

  const rt = await openRuntime(actor, space, clock, { installReferenceExtension: false });
  let disposition: "created" | "joined";
  try {
    const result = await bootstrapCoordinationSpace(rt.db, {
      workspaceId: space,
      actor,
      clock: rt.ctx.clock,
    });
    disposition = result.disposition;
  } finally {
    await rt.close();
  }

  const current = loadConfig();
  const next = {
    ...current,
    dbPath: current.dbPath || defaultDbPath(),
    tenantId: space,
    defaultActor: actor,
  };
  saveConfig(next);
  const result = {
    contractVersion: "tasq.human-setup.v1",
    disposition,
    space,
    actor,
    configPath: join(configDir(), "config.json"),
    nextArgv: [
      ["tasq", "add", "Write the first commitment", "--next", "Open the relevant file"],
      ["tasq", "list"],
      ["tasq", "done", "{commitmentId}"],
    ],
    boundary: "local-explicit-store",
  };
  if (json) printJson(result);
  else {
    printInfo([
      `Tasq is ready for ${actor} in ${space}.`,
      'Next: tasq add "Write the first commitment" --next "Open the relevant file"',
      "Then: tasq list",
    ].join("\n"));
  }
  return 0;
}

async function runIsolated(
  executable: string,
  home: string,
  argv: string[],
): Promise<unknown> {
  const child = Bun.spawn([executable, ...argv], {
    env: {
      ...process.env,
      TASQ_HOME: home,
      TASQ_DB_URL: "",
      TASQ_EVENT_JOURNAL_PATH: "",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`isolated demo command failed (${exitCode}): ${stderr.trim() || stdout.trim()}`);
  }
  return JSON.parse(stdout);
}

/** Run a complete assertion-mode journey without consulting the live home. */
export async function demoCmd(
  args: ParsedArgs,
  executable: string,
): Promise<number> {
  const json = args.bool("json", "j");
  if (args.positional.length > 0) throw new Error("demo accepts no positional arguments");
  const root = await mkdtemp(join(tmpdir(), "tasq-demo-"));
  const home = join(root, "home");
  await mkdir(home, { mode: 0o700 });
  try {
    const setup = await runIsolated(executable, home, [
      "setup", "--space", "demo/local", "--actor", "demo:human", "--json",
    ]);
    const created = await runIsolated(executable, home, [
      "add", "Ship the demo outcome", "--next", "Run tasq list", "--json",
    ]) as { id: string };
    const before = await runIsolated(executable, home, ["list", "--json"]);
    const completed = await runIsolated(executable, home, [
      "done", created.id, "--note", "Completed inside the isolated demo", "--json",
    ]);
    const after = await runIsolated(executable, home, ["inspect", created.id, "--json"]);
    const result = {
      contractVersion: "tasq.isolated-demo.v1",
      isolation: "temporary-home-removed-after-run",
      liveHomeConsulted: false,
      setup,
      created,
      before,
      completed,
      after,
    };
    if (json) printJson(result);
    else {
      printInfo([
        "Tasq isolated demo completed.",
        `Created and completed: ${created.id}`,
        "Your configured TASQ_HOME and ledger were not read or changed.",
      ].join("\n"));
    }
    return 0;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function agentPlan(
  host: AgentHost,
  executable: string,
  space: string,
  actor: string,
  capabilities: Capability[],
  target: string | undefined,
) {
  const serverArgv = [
    executable, "mcp", "--tenant", space, "--actor", actor,
    "--capabilities", capabilities.join(","),
  ];
  const configuration = {
    command: serverArgv[0],
    args: serverArgv.slice(1),
    env: {},
  };
  const applyArgv = host === "codex"
    ? ["codex", "mcp", "add", "tasq", "--", ...serverArgv]
    : host === "claude"
      ? ["claude", "mcp", "add", "tasq", "--scope", "user", "--", ...serverArgv]
      : null;
  return {
    contractVersion: "tasq.agent-install-plan.v1",
    host,
    executable,
    space,
    actor,
    capabilities,
    mutatesHost: false,
    applyArgv,
    genericTarget: host === "generic" ? target ?? null : null,
    configuration: host === "generic"
      ? { mcpServers: { tasq: configuration } }
      : configuration,
    authority: {
      actorAuthentication: "local_process_self_asserted",
      effectAuthority: "not_granted",
      repositoryDescriptorActivation: "explicit-trust-required",
    },
  };
}

async function runHostInstaller(argv: string[]): Promise<void> {
  const child = Bun.spawn(argv, { stdin: "ignore", stdout: "inherit", stderr: "inherit" });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`${argv[0]} exited with ${exitCode}`);
}

/**
 * Preview by default. --apply delegates host mutation to the native host CLI,
 * or writes generic JSON only to an explicit absolute target.
 */
export async function agentCmd(
  args: ParsedArgs,
  executableFromHost: string,
): Promise<number> {
  const [subcommand, rawHost] = args.positional;
  if (subcommand !== "install" || !rawHost || args.positional.length !== 2) {
    throw new Error("agent install <codex|claude|generic> --space <id> --actor <label> [--apply]");
  }
  if (!["codex", "claude", "generic"].includes(rawHost)) {
    throw new Error(`unsupported agent host: ${rawHost}`);
  }
  const host = rawHost as AgentHost;
  const space = CoordinationSpaceId.parse(args.string("space"));
  const actor = BootstrapActorAlias.parse(args.string("actor"));
  const capabilities = parseCapabilities(args.string("capabilities"));
  const executableInput = args.string("executable") ?? executableFromHost;
  const executable = resolve(executableInput);
  if (!isAbsolute(executable) || !existsSync(executable)) {
    throw new Error("--executable must resolve to an existing absolute Tasq executable");
  }
  const target = args.string("target");
  const apply = args.bool("apply");
  const plan = agentPlan(host, executable, space, actor, capabilities, target);

  if (apply) {
    if (host === "generic") {
      if (!target || !isAbsolute(target)) {
        throw new Error("generic --apply requires an explicit absolute --target");
      }
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      const current = existsSync(target) ? await readFile(target, "utf8") : null;
      if (current !== null) {
        const digest = createHash("sha256").update(current).digest("hex");
        throw new Error(`refusing to overwrite existing generic config (${digest})`);
      }
      await writeFile(target, `${JSON.stringify(plan.configuration, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
    } else {
      await runHostInstaller(plan.applyArgv!);
    }
  }

  const result = { ...plan, applied: apply };
  if (args.bool("json", "j")) printJson(result);
  else printInfo(JSON.stringify(result, null, 2));
  return 0;
}
