import { createHash } from "node:crypto";
import { existsSync, lstatSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
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
  bindDirectorySpace,
  canonicalDirectory,
  configDir,
  defaultDbPath,
  inheritedSpaceOwnedElsewhere,
  loadConfig,
  saveConfig,
  resolveDirectorySpace,
} from "../config.js";
import { color, printInfo, printJson, shortId } from "../output/format.js";
import { openRuntime } from "../runtime.js";
import { loadOrCreateDeviceIdentity } from "../identity.js";
import { agentInstructionsCmd, writeManagedBlock } from "./agent-instructions.js";

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

/**
 * Setting a project up binds this directory AND everything under it, and drops
 * an AGENTS.md here. Both are right in a repository and wrong in a home
 * directory: binding `~` makes every project below it inherit this space,
 * which is the silent-inheritance defect that cost this project's own ledger a
 * migration under a binary nobody meant to run there.
 */
function assertProjectDirectory(directory: string): void {
  // Both sides canonicalised: process.cwd() resolves symlinks and homedir()
  // does not, so on macOS, where /var is a link to /private/var, a plain
  // comparison silently never matches.
  const here = canonicalDirectory(directory);
  const isRoot = dirname(here) === here;
  if (here !== canonicalDirectory(homedir()) && !isRoot) return;
  throw new Error(
    `Refusing to set up a project in ${here}.\n`
    + (isRoot
      ? "That is the filesystem root."
      : "That is your home directory, so every project below it would inherit this space "
        + "and the AGENTS.md would land in your home rather than in a repository.")
    + "\nRun this from the project directory, or pass --no-bind --no-instructions "
    + "if you only meant to set the global default.",
  );
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
 *
 * It also does the two things that used to be separate commands nobody was
 * told about. Bringing Tasq into a project required `setup`, then `use` to
 * bind the directory, then `agent instructions --write` to teach the agents -
 * and `setup` mentioned neither, so the honest answer to "what do I run in a
 * new project" was "read the help and assemble it yourself".
 *
 * Both are skippable, because a second project sharing one space is a real
 * case and a repository whose AGENTS.md is managed elsewhere is another. What
 * is NOT optional is saying what happened: silent directory binding is the
 * defect that migrated this project's own ledger under the wrong binary.
 */
export async function setupCmd(args: ParsedArgs, clock: Clock): Promise<number> {
  const json = args.bool("json", "j");
  if (args.positional.length > 0) throw new Error("setup accepts flags only");
  const current0 = loadConfig();
  const requested = args.string("space");
  // A project that is already bound is set up again for ITS space, never for
  // whatever the global default happens to be that day.
  const boundHere = resolveDirectorySpace(current0, process.cwd());
  const inheritable = boundHere?.space ?? (current0.tenantId || undefined);
  if (requested === undefined && inheritable === undefined) {
    throw new Error(
      "setup --space <id> --actor <label>\n"
      + "There is no configured space to inherit yet, so the first one has to be named.",
    );
  }
  // The space may be inherited, but never silently: an inherited space is how
  // work lands in someone else's ledger.
  const space = CoordinationSpaceId.parse(requested ?? inheritable);
  const spaceSource: "explicit" | "inherited-from-directory" | "inherited-from-config" = requested !== undefined
    ? "explicit"
    : boundHere
      ? "inherited-from-directory"
      : "inherited-from-config";
  const inherited = requested === undefined;
  const actorInput = args.string("actor") ?? current0.defaultActor;
  if (!actorInput) {
    throw new Error(
      "setup --space <id> --actor <label>\n"
      + "Attribution is not optional: every claim in the ledger names who made it.",
    );
  }
  const actor = BootstrapActorAlias.parse(actorInput);
  const bind = !args.bool("no-bind");
  const teach = !args.bool("no-instructions");
  const force = args.bool("force");
  const instructionsTarget = resolve(args.string("target") ?? "AGENTS.md");
  if (bind || teach) assertProjectDirectory(process.cwd());
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
  // Setting a project up binds THIS directory. It used to also make the
  // project's space the global default for every unbound directory on the
  // machine - so one agent setting up a scratch project redirected every
  // other checkout, and this project's own lost its binding on 2026-09-02.
  // The global default now moves only on request, or when there is none yet.
  const wantsDefault = args.bool("default");
  // A config that does not exist on disk yet has no default, whatever the
  // built-in fallback says: the first project a machine sets up becomes it.
  const hadDefault = existsSync(join(configDir(), "config.json")) && Boolean(current.tenantId);
  const globalDefault = wantsDefault || !hadDefault ? space : current.tenantId;
  const globalDefaultSource: "flag" | "first" | "kept" = wantsDefault ? "flag" : hadDefault ? "kept" : "first";
  let next = {
    ...current,
    dbPath: current.dbPath || defaultDbPath(),
    tenantId: globalDefault,
    defaultActor: actor,
  };

  // Asked BEFORE binding: once this directory owns the space too, the question
  // "who else is bound to it" can only answer nobody. Sharing a space across
  // projects is legitimate, so this is said out loud rather than refused.
  const conflicts = inheritedSpaceOwnedElsewhere(next, space, process.cwd());

  let binding: { directory: string; changed: boolean } | null = null;
  if (bind) {
    const bound = bindDirectorySpace(next, process.cwd(), space);
    next = bound.config;
    binding = { directory: bound.directory, changed: bound.changed };
  }
  saveConfig(next, { command: ["setup", ...(wantsDefault ? ["--default"] : [])] });

  // Establish this installation's device identity here rather than on the
  // first write. The actor label is chosen freely and always will be; the key
  // is what lets the ledger later say that two machines used one label.
  const device = loadOrCreateDeviceIdentity(clock.now());

  let instructions: { target: string; changed: boolean; digest: string } | null = null;
  if (teach) {
    const written = writeManagedBlock(instructionsTarget, space, force);
    instructions = { target: written.target, changed: written.changed, digest: written.digest };
  }

  const result = {
    contractVersion: "tasq.human-setup.v3",
    disposition,
    space,
    spaceSource,
    actor,
    globalDefault: {
      space: globalDefault,
      changed: globalDefault !== current.tenantId,
      source: globalDefaultSource,
    },
    device: device ? { fingerprint: device.fingerprint, algorithm: device.algorithm } : null,
    configPath: join(configDir(), "config.json"),
    directoryBinding: binding,
    agentInstructions: instructions,
    otherDirectoriesUsingThisSpace: conflicts,
    nextArgv: [
      ["tasq", "add", "The first thing an agent should pick up", "--next", "Open the relevant file"],
      ["tasq", "fleet"],
      ["tasq", "demo"],
    ],
    boundary: "local-explicit-store",
  };
  if (json) printJson(result);
  else {
    const lines: string[] = [];
    lines.push(`${color.green("✓")} ${disposition === "created" ? "Created" : "Joined"} ${color.bold(space)} as ${actor}.`);
    if (device) {
      lines.push(color.dim(`  this installation signs as ${device.fingerprint.slice(0, 12)} - see \`tasq whoami\``));
    }
    if (inherited) {
      lines.push(color.dim(spaceSource === "inherited-from-directory"
        ? `  space inherited from this directory's binding; pass --space to choose another`
        : `  space inherited from ${join(configDir(), "config.json")}; pass --space to choose another`));
    }
    if (binding) {
      lines.push(`${color.green("✓")} Bound ${binding.directory} and everything under it to this space.`);
    } else {
      lines.push(color.dim("  directory not bound (--no-bind); this shell falls back to the global default"));
    }
    if (globalDefault !== current.tenantId) {
      lines.push(`${color.green("✓")} Global default for unbound directories is now ${globalDefault}.`);
    } else if (globalDefault !== space) {
      lines.push(color.dim(`  global default stays ${globalDefault}; pass --default to make ${space} the fallback for unbound directories`));
    }
    if (instructions) {
      lines.push(instructions.changed
        ? `${color.green("✓")} Wrote the managed Tasq block into AGENTS.md, so agents here know the rules.`
        : `${color.green("✓")} AGENTS.md already carries the current managed Tasq block.`);
    } else {
      lines.push(color.dim("  AGENTS.md untouched (--no-instructions); agents here will not be told about Tasq"));
    }
    if (conflicts.length > 0) {
      lines.push("");
      lines.push(color.yellow(`  ! ${space} is also bound in: ${conflicts.join(", ")}`));
      lines.push(color.dim("    Those projects share this ledger. That is fine if you meant it."));
    }
    lines.push("");
    // The old next-step block was add, list, done - a single-player todo app,
    // under a headline promising a tracker you share with your agents.
    lines.push(color.bold("Now put an agent on it."));
    lines.push(`  ${color.dim("$")} tasq add "The first thing an agent should pick up" --next "Open the relevant file"`);
    lines.push(`  ${color.dim("$")} tasq fleet          ${color.dim("who is holding what, right now")}`);
    lines.push(`  ${color.dim("$")} tasq demo           ${color.dim("two agents on one task, in a throwaway home")}`);
    printInfo(lines.join("\n"));
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

/**
 * Run a step the demo EXPECTS to be refused, and return the typed problem
 * contract. The refusals are the point of the demo: they are what a shared
 * ledger does that a scratchpad cannot.
 */
async function runIsolatedRefusal(
  executable: string,
  home: string,
  argv: string[],
): Promise<{ code: string; summary: string }> {
  const child = Bun.spawn([executable, ...argv], {
    env: { ...process.env, TASQ_HOME: home, TASQ_DB_URL: "", TASQ_EVENT_JOURNAL_PATH: "" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode === 0) {
    throw new Error(`isolated demo expected a refusal from: ${argv.join(" ")}`);
  }
  const problem = JSON.parse(stdout) as { code?: string; summary?: string };
  if (!problem.summary) {
    throw new Error(`isolated demo refusal carried no problem contract: ${stderr.trim()}`);
  }
  return { code: problem.code ?? "refused", summary: problem.summary };
}

/**
 * Play the scene the product exists for, in an isolated home: two agents on
 * one task, exclusive ownership, and a completion that needs a receipt.
 *
 * The previous demo ran add, list, done with a single actor, which is what any
 * todo CLI does, under a headline promising that agents stay aligned. The
 * refusals below are the difference, so they are the demo.
 */
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
      // No binding and no AGENTS.md: the demo runs in the user's working
      // directory, and it promises below that nothing outside the throwaway
      // home was touched. Setup now writes two things by default, so the demo
      // has to say it wants neither.
      "setup", "--space", "demo/local", "--actor", "demo:human",
      "--no-bind", "--no-instructions", "--json",
    ]);
    const created = await runIsolated(executable, home, [
      "add", "Ship the release notes",
      "--next", "Draft and publish",
      "--completion", "evidence",
      "--success", "The published URL is attached as evidence",
      "--json",
    ]) as { id: string };

    // One agent takes exclusive ownership; the second is refused, by name.
    const claimed = await runIsolated(executable, home, [
      "claim", created.id, "--for", "30m", "--actor", "agent:a", "--json",
    ]) as { expiresAt: number };
    const claimRefused = await runIsolatedRefusal(executable, home, [
      "claim", created.id, "--for", "30m", "--actor", "agent:b", "--json",
    ]);

    // Closing is the decisive act, so the claim guards it too.
    const closeRefused = await runIsolatedRefusal(executable, home, [
      "done", created.id, "--actor", "agent:b", "--json",
    ]);

    // The holder cannot close on its own say-so either: proof is required.
    const evidenceRefused = await runIsolatedRefusal(executable, home, [
      "done", created.id, "--actor", "agent:a", "--note", "trust me", "--json",
    ]);
    const evidence = await runIsolated(executable, home, [
      "evidence", "add", created.id,
      "--kind", "url",
      "--uri", "https://example.test/release-notes",
      "--summary", "Published release notes",
      "--actor", "agent:a", "--json",
    ]) as { id: string };
    const completed = await runIsolated(executable, home, [
      "done", created.id, "--evidence", evidence.id, "--actor", "agent:a", "--json",
    ]);
    const after = await runIsolated(executable, home, ["inspect", created.id, "--json"]);

    const result = {
      contractVersion: "tasq.isolated-demo.v2",
      isolation: "temporary-home-removed-after-run",
      liveHomeConsulted: false,
      setup,
      created,
      claimed,
      refusals: {
        secondClaim: claimRefused,
        closeByNonHolder: closeRefused,
        closeWithoutEvidence: evidenceRefused,
      },
      evidence,
      completed,
      after,
    };
    if (json) printJson(result);
    else {
      const expiry = new Date(claimed.expiresAt).toISOString().slice(11, 16);
      printInfo([
        `${color.bold("Two agents, one task.")} Everything below ran in a throwaway home.`,
        "",
        `  ${color.dim("$")} tasq add "Ship the release notes" --completion evidence`,
        `    ${color.green("✓")} ${shortId(created.id)}  closing this one will require proof`,
        "",
        `  ${color.dim("$")} tasq claim ${shortId(created.id)} --actor agent:a --for 30m`,
        `    ${color.green("✓")} agent:a owns it until ${expiry} UTC`,
        "",
        `  ${color.dim("$")} tasq claim ${shortId(created.id)} --actor agent:b`,
        `    ${color.red("refused")} ${claimRefused.summary}`,
        "",
        `  ${color.dim("$")} tasq done ${shortId(created.id)} --actor agent:b`,
        `    ${color.red("refused")} ${closeRefused.summary}`,
        "",
        `  ${color.dim("$")} tasq done ${shortId(created.id)} --actor agent:a --note "trust me"`,
        `    ${color.red("refused")} ${evidenceRefused.summary}`,
        "",
        `  ${color.dim("$")} tasq evidence add ... && tasq done ... --evidence`,
        `    ${color.green("✓")} done, with a receipt you can inspect`,
        "",
        color.dim("Your configured TASQ_HOME and ledger were not read or changed."),
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
    // Agent integrations default to evidence-backed completion: this is the
    // registration that makes "they cannot mark anything done without a
    // receipt you can inspect" true for the work an agent proposes.
    "--completion", "evidence",
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
  if (args.positional[0] === "instructions") return agentInstructionsCmd(args);
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
