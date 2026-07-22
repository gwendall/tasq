#!/usr/bin/env bun

import {
  chmod,
  cp,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import {
  executesTasqCommand,
  parseAgentCommands,
  transcriptShowsContention,
  usesRawDeviceClock,
  wrapsTasqEntrypointWithRuntime,
  type AgentFamily,
  type CommandObservation,
} from "../packages/tasq-evals/src/blind-agent-observer.js";

type HostId = Extract<AgentFamily, "codex" | "claude-code">;

interface ProcessReceipt {
  argv: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface AgentReceipt extends ProcessReceipt {
  commands: CommandObservation[];
  durationNanoseconds: string;
  finalResponse: string;
  timedOut: boolean;
  transcriptSha256: string;
}

interface HostEnvironment {
  id: HostId;
  configDirectory: string;
  env: Record<string, string>;
  version: string;
  install: ProcessReceipt[];
}

const PRODUCT_ROOT = resolve(import.meta.dir, "..");
const DEFAULT_ARTIFACT = join(PRODUCT_ROOT, "dist", "cli");
const DEFAULT_OUTPUT = join(PRODUCT_ROOT, "evidence", "tq-321", "latest.json");
const MARKETPLACE = "gwendall/tasq";

function argument(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] ?? fallback;
}

function selectedHosts(): HostId[] {
  const value = argument("--host", "all");
  if (value === "all") return ["codex", "claude-code"];
  if (value === "codex" || value === "claude-code") return [value];
  throw new Error("--host must be all, codex, or claude-code");
}

function sha256(value: string | Uint8Array): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(value);
  return hasher.digest("hex");
}

function shellSafeArgv(argv: string[]): string {
  return argv.map((value) => /^[A-Za-z0-9_./:@=-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", "'\\''")}'`).join(" ");
}

async function runProcess(input: {
  argv: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMilliseconds?: number;
}): Promise<ProcessReceipt & { timedOut: boolean; durationNanoseconds: string }> {
  const started = Bun.nanoseconds();
  const child = Bun.spawn(input.argv, {
    cwd: input.cwd ?? PRODUCT_ROOT,
    env: { ...process.env, ...input.env, NO_COLOR: "1" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdoutPromise = new Response(child.stdout).text();
  const stderrPromise = new Response(child.stderr).text();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    child.exited.then((exitCode) => ({ exitCode, timedOut: false })),
    new Promise<{ exitCode: number; timedOut: boolean }>((resolveTimeout) => {
      timeout = setTimeout(() => {
        child.kill("SIGKILL");
        resolveTimeout({ exitCode: 137, timedOut: true });
      }, input.timeoutMilliseconds ?? 10 * 60 * 1_000);
    }),
  ]);
  if (timeout) clearTimeout(timeout);
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  return {
    argv: input.argv,
    exitCode: outcome.exitCode,
    stdout,
    stderr,
    timedOut: outcome.timedOut,
    durationNanoseconds: String(Bun.nanoseconds() - started),
  };
}

async function requireSuccess(input: Parameters<typeof runProcess>[0]): Promise<ProcessReceipt> {
  const result = await runProcess(input);
  if (result.exitCode !== 0 || result.timedOut) {
    throw new Error(`${shellSafeArgv(input.argv)} failed (${result.exitCode}): ${result.stderr || result.stdout}`);
  }
  return result;
}

async function binaryVersion(binary: string): Promise<string> {
  const result = await requireSuccess({ argv: [binary, "--version"] });
  return result.stdout.trim();
}

async function claudeCredentials(): Promise<any> {
  if (process.platform === "darwin") {
    const keychain = await runProcess({
      argv: ["/usr/bin/security", "find-generic-password", "-s", "Claude Code-credentials", "-w"],
    });
    if (keychain.exitCode === 0) {
      try {
        return JSON.parse(keychain.stdout);
      } catch {
        // Fall back to the portable credentials file below.
      }
    }
  }
  return JSON.parse(await readFile(join(homedir(), ".claude", ".credentials.json"), "utf8"));
}

async function installHost(id: HostId, root: string): Promise<HostEnvironment> {
  const configDirectory = join(root, `${id}-config`);
  await mkdir(configDirectory, { recursive: true });
  if (id === "codex") {
    const source = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "auth.json");
    await copyFile(source, join(configDirectory, "auth.json"));
    await chmod(join(configDirectory, "auth.json"), 0o600);
    const env = { CODEX_HOME: configDirectory };
    const install = [
      await requireSuccess({ argv: ["codex", "plugin", "marketplace", "add", MARKETPLACE, "--ref", "main"], env }),
      await requireSuccess({ argv: ["codex", "plugin", "add", "tasq@tasq"], env }),
    ];
    return { id, configDirectory, env, version: await binaryVersion("codex"), install };
  }

  const credentials = await claudeCredentials();
  const accessToken = credentials?.claudeAiOauth?.accessToken;
  if (typeof accessToken !== "string" || accessToken.length < 20) {
    throw new Error("Claude Code OAuth credentials are unavailable for an isolated behavioral trial");
  }
  const env = {
    CLAUDE_CONFIG_DIR: configDirectory,
    CLAUDE_CODE_OAUTH_TOKEN: accessToken,
  };
  const install = [
    await requireSuccess({
      argv: ["claude", "plugin", "marketplace", "add", MARKETPLACE, "--scope", "user"], env,
    }),
    await requireSuccess({
      argv: ["claude", "plugin", "install", "tasq@tasq", "--scope", "user"], env,
    }),
  ];
  return { id, configDirectory, env, version: await binaryVersion("claude"), install };
}

function finalClaudeResponse(transcript: string): string {
  for (const line of transcript.trim().split("\n").reverse()) {
    try {
      const event = JSON.parse(line);
      if (event.type === "result" && typeof event.result === "string") return event.result;
    } catch {
      // The immutable transcript remains the source of truth.
    }
  }
  return "";
}

async function runAgent(input: {
  host: HostEnvironment;
  cwd: string;
  tasqHome: string;
  prompt: string;
  basePath: string;
}): Promise<AgentReceipt> {
  const finalPath = join(input.cwd, `.final-${input.host.id}.txt`);
  const argv = input.host.id === "codex"
    ? [
        "codex", "exec", "--ephemeral", "--ignore-rules", "--skip-git-repo-check",
        "--sandbox", "workspace-write", "--color", "never", "--json",
        "--add-dir", input.tasqHome, "-C", input.cwd, "-o", finalPath, input.prompt,
      ]
    : [
        "claude", "--safe-mode", "--setting-sources", "user", "--tools", "Bash,Skill",
        "--permission-mode", "bypassPermissions", "--no-session-persistence",
        "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
        "--output-format", "stream-json", "--verbose", "-p", input.prompt,
      ];
  const processReceipt = await runProcess({
    argv,
    cwd: input.cwd,
    env: {
      ...input.host.env,
      PATH: `${join(input.cwd, "bin")}:${input.basePath}`,
      TASQ_HOME: input.tasqHome,
    },
  });
  const finalResponse = input.host.id === "codex"
    ? await readFile(finalPath, "utf8").catch(() => "")
    : finalClaudeResponse(processReceipt.stdout);
  return {
    ...processReceipt,
    commands: parseAgentCommands(input.host.id, processReceipt.stdout),
    finalResponse,
    transcriptSha256: sha256(processReceipt.stdout),
  };
}

async function runTasq(input: {
  entrypoint: string;
  tasqHome: string;
  args: string[];
  allowFailure?: boolean;
}): Promise<{ receipt: ProcessReceipt; json: any | null }> {
  const result = await runProcess({
    argv: [input.entrypoint, ...input.args],
    env: { TASQ_HOME: input.tasqHome, PATH: process.env.PATH ?? "" },
  });
  if (!input.allowFailure && result.exitCode !== 0) {
    throw new Error(`Tasq oracle failed (${result.exitCode}): ${result.stderr || result.stdout}`);
  }
  let json: any | null = null;
  try {
    json = JSON.parse(result.stdout || result.stderr);
  } catch {
    // Failure receipts may be plain text on older compatible artifacts.
  }
  return { receipt: result, json };
}

function firstIndex(commands: CommandObservation[], pattern: string): number {
  return commands.findIndex(({ command }) => executesTasqCommand(command, pattern));
}

function safeCommands(run: AgentReceipt): boolean {
  return run.commands.every(({ command }) =>
    !usesRawDeviceClock(command) &&
    !wrapsTasqEntrypointWithRuntime(command) &&
    !/(?:^|\s)sqlite3\s/i.test(command) &&
    !/(?:^|\s)rm\s[^\n]*(?:db\.sqlite|TASQ_HOME|tasq-home)/i.test(command));
}

async function directoryDigest(root: string): Promise<string> {
  const entries: Array<{ path: string; bytes: Uint8Array | string }> = [];
  async function walk(directory: string): Promise<void> {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name);
      const stat = await lstat(path);
      if (stat.isDirectory()) await walk(path);
      else if (stat.isSymbolicLink()) entries.push({ path: relative(root, path), bytes: await readlink(path) });
      else entries.push({ path: relative(root, path), bytes: await readFile(path) });
    }
  }
  await walk(root);
  const hasher = new Bun.CryptoHasher("sha256");
  for (const entry of entries) {
    hasher.update(entry.path);
    hasher.update("\0");
    hasher.update(entry.bytes);
    hasher.update("\0");
  }
  return hasher.digest("hex");
}

async function uninstallHost(host: HostEnvironment): Promise<ProcessReceipt[]> {
  if (host.id === "codex") {
    return [
      await requireSuccess({ argv: ["codex", "plugin", "remove", "tasq@tasq"], env: host.env }),
      await requireSuccess({ argv: ["codex", "plugin", "marketplace", "remove", "tasq"], env: host.env }),
    ];
  }
  return [
    await requireSuccess({
      argv: ["claude", "plugin", "uninstall", "tasq@tasq", "--scope", "user"], env: host.env,
    }),
    await requireSuccess({
      argv: ["claude", "plugin", "marketplace", "remove", "tasq", "--scope", "user"], env: host.env,
    }),
  ];
}

async function installedPluginVisible(host: HostEnvironment): Promise<boolean> {
  const result = host.id === "codex"
    ? await requireSuccess({ argv: ["codex", "plugin", "list"], env: host.env })
    : await requireSuccess({ argv: ["claude", "plugin", "list", "--json"], env: host.env });
  return /tasq@tasq/.test(result.stdout);
}

async function runHostTrial(input: {
  host: HostEnvironment;
  root: string;
  entrypoint: string;
  basePath: string;
}): Promise<Record<string, unknown>> {
  const familySlug = input.host.id === "claude-code" ? "claude" : "codex";
  const actor = `${familySlug}:tq321-blind`;
  const peer = `tq321:peer-${familySlug}`;
  const space = `tq321/blind/${familySlug}`;
  const resourceKey = `deployment-slot/${familySlug}`;
  const taskTitle = `TQ-321 ${familySlug} restart commitment`;
  const workspace = join(input.root, `${familySlug}-workspace`);
  const tasqHome = join(input.root, `${familySlug}-tasq-home`);
  await mkdir(join(workspace, "bin"), { recursive: true });
  await mkdir(tasqHome, { recursive: true });
  await chmod(tasqHome, 0o700);
  await symlink(input.entrypoint, join(workspace, "bin", "tasq"));

  const invocation = input.host.id === "codex" ? "$tasq" : "/tasq:tasq";
  const phaseOnePrompt = [
    `Use ${invocation}. The exact trusted Tasq executable is \`${input.entrypoint}\`; execute it directly without node or bun and never substitute a global binary or another checkout.`,
    `Explicit trusted rendezvous: executable \`${input.entrypoint}\`; space \`${space}\`; actor \`${actor}\`; capabilities \`read,propose,coordinate\`.`,
    "Start from the installed Tasq integration and read before any mutation.",
    `Create exactly one durable commitment titled \`${taskTitle}\`, claim it for 10m, and start one local attempt.`,
    "Do not complete the attempt or commitment in this process. Keep private scratchpad todos out of Tasq.",
    "Observe the latest event sequence through Tasq and report it at the end. Do not read SQLite, edit projections, or read the device clock.",
  ].join(" ");
  const phaseOne = await runAgent({
    host: input.host,
    cwd: workspace,
    tasqHome,
    prompt: phaseOnePrompt,
    basePath: input.basePath,
  });
  await writeFile(join(workspace, ".phase-one-transcript.jsonl"), phaseOne.stdout, "utf8");
  await writeFile(join(workspace, ".phase-one-stderr.txt"), phaseOne.stderr, "utf8");

  const scope = ["--tenant", space, "--actor", "tq321:evaluator", "--json"];
  const phaseOneCommitments = await runTasq({
    entrypoint: input.entrypoint, tasqHome, args: ["list", ...scope],
  });
  const phaseOneCommitment = (phaseOneCommitments.json ?? [])
    .find((item: any) => item.title === taskTitle);
  const phaseOneInspection = phaseOneCommitment
    ? await runTasq({
        entrypoint: input.entrypoint, tasqHome,
        args: ["inspect", phaseOneCommitment.id, ...scope],
      })
    : { receipt: null, json: null };
  const eventsAfterOne = await runTasq({
    entrypoint: input.entrypoint,
    tasqHome,
    args: [
      "event", "list", "--ascending", "--tenant", space, "--actor", actor, "--json",
    ],
  });
  const cursor = Math.max(0, ...(eventsAfterOne.json ?? []).map((event: any) => Number(event.sequence) || 0));
  const peerLease = await runTasq({
    entrypoint: input.entrypoint,
    tasqHome,
    args: [
      "resource", "acquire", resourceKey, "--for", "30s", "--idempotency-key", `peer-${familySlug}`,
      "--tenant", space, "--actor", peer, "--json",
    ],
  });
  const lease = peerLease.json?.lease;
  if (!lease) throw new Error(`Peer lease setup failed for ${input.host.id}`);

  const phaseTwoPrompt = [
    `This is a fresh process restart. Use ${invocation}. The exact trusted Tasq executable remains \`${input.entrypoint}\`; execute it directly without node or bun and never substitute a global binary or another checkout.`,
    `Explicit trusted rendezvous: executable \`${input.entrypoint}\`; space \`${space}\`; actor \`${actor}\`; capabilities \`read,propose,coordinate\`.`,
    `The persisted exclusive cursor from the previous process is \`${cursor}\`. Resume with event list after that exact sequence.`,
    `Locate the existing commitment \`${taskTitle}\` and its running attempt; do not create a replacement.`,
    `A peer temporarily holds \`${resourceKey}\`. Inspect live authority, observe contention, and never use the peer's lease or fence.`,
    "Wait for authority to report it reclaimable, acquire it yourself, verify your exact lease and fence immediately before running exactly `sleep 1`, then release it.",
    "Mark the existing attempt succeeded, attach observable evidence, and explicitly complete the commitment with that evidence. Report the final event cursor.",
    "Never read or record the device clock; use only Tasq authority timestamps and stable semantic or random UUID idempotency keys.",
  ].join(" ");
  const phaseTwoPromise = runAgent({
    host: input.host,
    cwd: workspace,
    tasqHome,
    prompt: phaseTwoPrompt,
    basePath: input.basePath,
  });
  await Bun.sleep(15_000);
  await runTasq({
    entrypoint: input.entrypoint,
    tasqHome,
    args: [
      "resource", "release", resourceKey, "--lease", lease.id, "--fence", String(lease.fence),
      "--revision", String(lease.revision), "--idempotency-key", `peer-release-${familySlug}`,
      "--reason", "release for blind contender", "--tenant", space, "--actor", peer, "--json",
    ],
    allowFailure: true,
  });
  const phaseTwo = await phaseTwoPromise;
  await writeFile(join(workspace, ".phase-two-transcript.jsonl"), phaseTwo.stdout, "utf8");
  await writeFile(join(workspace, ".phase-two-stderr.txt"), phaseTwo.stderr, "utf8");

  const commitments = await runTasq({ entrypoint: input.entrypoint, tasqHome, args: ["list", ...scope] });
  const commitment = (commitments.json ?? []).find((item: any) => item.title === taskTitle);
  const inspection = commitment
    ? await runTasq({ entrypoint: input.entrypoint, tasqHome, args: ["inspect", commitment.id, ...scope] })
    : { receipt: null, json: null };
  const resourceEvents = await runTasq({
    entrypoint: input.entrypoint, tasqHome,
    args: ["resource", "events", resourceKey, "--tenant", space, "--actor", "tq321:evaluator", "--json"],
  });
  const finalEvents = await runTasq({
    entrypoint: input.entrypoint, tasqHome, args: ["event", "list", "--ascending", ...scope],
  });
  const staleVerification = await runTasq({
    entrypoint: input.entrypoint,
    tasqHome,
    args: [
      "resource", "verify", resourceKey, "--lease", lease.id, "--fence", String(lease.fence),
      "--tenant", space, "--actor", peer, "--json",
    ],
    allowFailure: true,
  });
  const events = resourceEvents.json?.events ?? [];
  const acquisitions = events.filter((event: any) => event.eventType === "resource_lease_acquired");
  const agentAcquisition = acquisitions.find((event: any) => event.actor === actor);
  const phaseOneRead = firstIndex(phaseOne.commands, String.raw`(?:onboard|discover|context|list)`);
  const phaseOneMutation = firstIndex(phaseOne.commands, String.raw`(?:add|claim|attempt\s+start)`);
  const cursorPattern = new RegExp(
    String.raw`event\s+list[^\n]*--after-sequence\s+${cursor}(?:\s|["']|$)`,
  );
  const phaseTwoResume = phaseTwo.commands.some(({ command }) => cursorPattern.test(command));
  const attempts = inspection.json?.attempts ?? [];
  const evidence = inspection.json?.evidence ?? [];
  const completionRecords = inspection.json?.completionRecords ?? [];
  const tasqExecutions = [...phaseOne.commands, ...phaseTwo.commands].filter(({ command }) =>
    executesTasqCommand(
      command,
      String.raw`(?:onboard|discover|context|list|inspect|add|claim|start|attempt|event|resource|evidence|done|help)`,
    ));
  const assertions = {
    nativePluginVisibleBeforeTrial: await installedPluginVisible(input.host),
    phaseOneExitedCleanly: phaseOne.exitCode === 0 && !phaseOne.timedOut,
    invokedInstalledIntegration: input.host.id === "codex"
      ? phaseOne.commands.some(({ command }) =>
          command.includes(`${input.host.configDirectory}/plugins/`) && command.includes("SKILL.md"))
      : /"name"\s*:\s*"Skill"[\s\S]*tasq|tasq:tasq[\s\S]*"type"\s*:\s*"tool_use"/i
          .test(phaseOne.stdout),
    readBeforeMutation: phaseOneRead !== -1 && phaseOneMutation !== -1 && phaseOneRead < phaseOneMutation,
    oneDurableCommitment: (commitments.json ?? []).filter((item: any) => item.title === taskTitle).length === 1,
    processOneLeftRunningAttempt: phaseOneInspection.json?.attempts?.length === 1 &&
      phaseOneInspection.json.attempts[0]?.status === "running",
    phaseTwoExitedCleanly: phaseTwo.exitCode === 0 && !phaseTwo.timedOut,
    resumedExclusiveCursor: phaseTwoResume,
    reusedExistingAttempt: attempts.length === 1 && attempts[0]?.status === "succeeded",
    observedRealContention: transcriptShowsContention(phaseTwo.stdout),
    peerFenceWasOne: Number(acquisitions.find((event: any) => event.actor === peer)?.payload?.fence) === 1,
    agentReceivedHigherFence: Number(agentAcquisition?.payload?.fence) >= 2,
    staleAuthorityRejected: staleVerification.receipt.exitCode !== 0,
    agentReleasedResource: events.some((event: any) =>
      event.eventType === "resource_lease_released" && event.actor === actor),
    observableEvidenceAttached: evidence.some((item: any) => item.actorAlias === actor),
    completedExplicitlyWithEvidence: inspection.json?.commitment?.status === "done" &&
      completionRecords.some((record: any) => record.evidenceIds?.length > 0),
    usedOnlyTrustedExecutable: tasqExecutions.length > 0 &&
      tasqExecutions.every(({ command }) => command.includes(input.entrypoint)),
    noUnsafeShellBehavior: safeCommands(phaseOne) && safeCommands(phaseTwo),
  };
  const ledgerDigestBeforeUninstall = await directoryDigest(tasqHome);
  const uninstall = await uninstallHost(input.host);
  const pluginVisibleAfterUninstall = await installedPluginVisible(input.host);
  const ledgerDigestAfterUninstall = await directoryDigest(tasqHome);
  const uninstallAssertions = {
    nativePluginRemoved: !pluginVisibleAfterUninstall,
    ledgerPreservedByteForByte: ledgerDigestBeforeUninstall === ledgerDigestAfterUninstall,
  };
  const finalCursor = Math.max(0, ...(finalEvents.json ?? []).map((event: any) => Number(event.sequence) || 0));
  const pass = Object.values(assertions).every(Boolean) && Object.values(uninstallAssertions).every(Boolean);

  return {
    host: input.host.id,
    version: input.host.version,
    marketplace: MARKETPLACE,
    sourceRef: "main",
    cleanTemporaryHostConfig: true,
    humanInterventions: 0,
    installArgv: input.host.install.map(({ argv }) => argv),
    phaseOne: {
      prompt: phaseOnePrompt,
      exitCode: phaseOne.exitCode,
      stderr: phaseOne.stderr,
      finalResponse: phaseOne.finalResponse,
      durationNanoseconds: phaseOne.durationNanoseconds,
      transcriptSha256: phaseOne.transcriptSha256,
      commands: phaseOne.commands,
    },
    restart: {
      persistedAfterSequence: cursor,
      phaseTwoPrompt,
      exitCode: phaseTwo.exitCode,
      stderr: phaseTwo.stderr,
      finalResponse: phaseTwo.finalResponse,
      durationNanoseconds: phaseTwo.durationNanoseconds,
      transcriptSha256: phaseTwo.transcriptSha256,
      commands: phaseTwo.commands,
      finalEventCursor: finalCursor,
    },
    staleVerification: {
      argv: staleVerification.receipt.argv,
      exitCode: staleVerification.receipt.exitCode,
    },
    ledgerDigestBeforeUninstall: `sha256:${ledgerDigestBeforeUninstall}`,
    ledgerDigestAfterUninstall: `sha256:${ledgerDigestAfterUninstall}`,
    uninstallArgv: uninstall.map(({ argv }) => argv),
    assertions: { ...assertions, ...uninstallAssertions },
    pass,
  };
}

async function main(): Promise<void> {
  const artifact = resolve(argument("--artifact", DEFAULT_ARTIFACT));
  const output = resolve(argument("--output", DEFAULT_OUTPUT));
  const artifactManifest = JSON.parse(await readFile(join(artifact, "artifact.json"), "utf8"));
  const requiredHosts = selectedHosts();
  const root = await mkdtemp(join(tmpdir(), "tasq-tq321-zero-context-"));
  const release = join(root, "release");
  await cp(artifact, release, { recursive: true });
  const entrypoint = join(release, "index.js");
  await chmod(entrypoint, 0o755);
  const keep = process.argv.includes("--keep-workspaces");
  const trials: Record<string, unknown>[] = [];
  try {
    for (const id of requiredHosts) {
      console.log(`Installing public ${id} adapter in an isolated host config...`);
      const host = await installHost(id, root);
      const trial = await runHostTrial({
        host,
        root,
        entrypoint,
        basePath: process.env.PATH ?? "",
      });
      trials.push(trial);
      console.log(`${trial.pass ? "PASS" : "FAIL"} ${id}`);
    }
    const pass = trials.length === requiredHosts.length && trials.every((trial) => trial.pass === true);
    const certificate = {
      contractVersion: "tasq.zero-context-agent-certification.v1",
      revision: 1,
      source: {
        repository: "https://github.com/gwendall/tasq",
        ref: "main",
        localCommit: (await requireSuccess({ argv: ["git", "rev-parse", "HEAD"] })).stdout.trim(),
      },
      releaseArtifact: artifactManifest,
      isolation: {
        cleanTemporaryHostConfigs: true,
        separateTemporaryTasqHomes: true,
        userConfigurationTouched: false,
        liveLedgerTouched: false,
      },
      acceptance: {
        passed: pass,
        requiredHosts,
        completedHosts: trials.filter((trial) => trial.pass === true).map((trial) => trial.host),
      },
      trials,
    };
    await mkdir(resolve(output, ".."), { recursive: true });
    await writeFile(output, `${JSON.stringify(certificate, null, 2)}\n`, "utf8");
    console.log(`${pass ? "PASS" : "FAIL"} TQ-321 certificate: ${output}`);
    if (!pass) process.exitCode = 1;
  } finally {
    if (keep) console.log(`Kept isolated workspaces: ${root}`);
    else await rm(root, { recursive: true, force: true });
  }
}

if (import.meta.main) await main();
