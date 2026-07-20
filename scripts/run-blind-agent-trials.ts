#!/usr/bin/env bun

import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  executesTasqCommand,
  executesResourceVerify,
  externalCheckIsVerified,
  isDomainNeutralDiscovery,
  isExternalCheckCommand,
  parseAgentCommands,
  transcriptShowsContention,
  usesRawDeviceClock,
  type AgentFamily,
  type CommandObservation,
} from "../packages/tasq-evals/src/blind-agent-observer.js";

export type TrialScenario = "new-space" | "existing-contention" | "crash-holder" | "crash-reclaim";

interface AgentRun {
  family: AgentFamily;
  actor: string;
  exitCode: number;
  durationNanoseconds: string;
  prompt: string;
  transcript: string;
  stderr: string;
  finalResponse: string;
  commands: CommandObservation[];
  timedOut: boolean;
}

interface LedgerEvaluation {
  actor: string;
  ownedCommitments: number;
  doneCommitmentsWithEvidence: number;
  atomicallyReleasedClaims: number;
  acquiredResource: boolean;
  releasedResource: boolean;
  eventCursor: number;
  resourceEventCursor: number;
  domainNeutralDiscovery: boolean;
  raw: Record<string, unknown>;
}

type LedgerFacts = Omit<LedgerEvaluation, "raw">;

interface BlobReference {
  digest: `sha256:${string}`;
  bytes: number;
  path: string;
}

interface TrialReceipt {
  contractVersion: "tasq.blind-agent-trial.v1";
  batchId: string;
  trialId: string;
  family: AgentFamily;
  scenario: TrialScenario;
  actor: string;
  space: string;
  resourceKey: string;
  autonomousCompletion: boolean;
  humanInterventions: 0;
  process: {
    exitCode: number;
    timedOut: boolean;
    durationNanoseconds: string;
    binaryVersion: string;
  };
  assertions: Record<string, boolean>;
  metrics: {
    commandCount: number;
    invalidCommandCount: number;
    commandsUntilFirstWorldView: number | null;
    commandsUntilFirstLease: number | null;
    authorityWideningAttempts: number;
    rawDeviceClockAttempts: number;
    recoveryChoice: "not_contended" | "wait_or_retry" | "safe_no_use" | "unresolved";
    finalEventCursor: number;
    finalResourceEventCursor: number;
  };
  prompt: string;
  blobs: {
    transcript: BlobReference;
    stderr: BlobReference;
    finalResponse: BlobReference;
    ledger: BlobReference;
  };
  rescore?: {
    sourceReceiptDigest: `sha256:${string}`;
    reason: string;
  };
}

interface TrialDraft {
  id: string;
  scenario: TrialScenario;
  space: string;
  resourceKey: string;
  home: string;
  run: AgentRun;
  ledger: LedgerEvaluation;
}

const PRODUCT_ROOT = resolve(import.meta.dir, "..");
const CLI_ARTIFACT = join(PRODUCT_ROOT, "packages", "tasq-cli", "dist");
const DEFAULT_EVIDENCE_ROOT = join(PRODUCT_ROOT, "evidence", "tq-315");
const POINTER_PREFIX = "Coordination between actors here happens via tasq; discover with";

function argument(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] ?? fallback;
}

function integerArgument(name: string, fallback: number): number {
  const parsed = Number(argument(name, String(fallback)));
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function sha256(bytes: string | Uint8Array): `sha256:${string}` {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(bytes);
  return `sha256:${hasher.digest("hex")}`;
}

async function archiveBlob(root: string, content: string, suffix: string): Promise<BlobReference> {
  const bytes = new TextEncoder().encode(content);
  const digest = sha256(bytes);
  const hex = digest.slice("sha256:".length);
  const relativePath = join("blobs", "sha256", `${hex}.${suffix}`);
  const path = join(root, relativePath);
  await mkdir(resolve(path, ".."), { recursive: true });
  await Bun.write(path, bytes);
  return { digest, bytes: bytes.byteLength, path: relativePath };
}

function finalClaudeResponse(transcript: string): string {
  for (const line of transcript.trim().split("\n").reverse()) {
    try {
      const event = JSON.parse(line);
      if (event.type === "result" && typeof event.result === "string") return event.result;
    } catch {
      // Raw transcript remains the source of truth when a line is malformed.
    }
  }
  return "";
}

async function binaryVersion(binary: string): Promise<string> {
  const process = Bun.spawn([binary, "--version"], { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout] = await Promise.all([process.exited, new Response(process.stdout).text()]);
  return exitCode === 0 ? stdout.trim() : "unknown";
}

function agentArguments(
  family: AgentFamily,
  cwd: string,
  writableHome: string,
  prompt: string,
  finalPath: string,
): string[] {
  if (family === "codex") {
    return [
      "codex", "exec", "--ephemeral", "--ignore-user-config", "--ignore-rules",
      "--skip-git-repo-check", "--sandbox", "workspace-write", "--color", "never",
      "--json", "--add-dir", writableHome, "-C", cwd, "-o", finalPath, prompt,
    ];
  }
  return [
    "claude", "--safe-mode", "--setting-sources", "", "--tools", "Bash",
    "--permission-mode", "bypassPermissions", "--no-session-persistence",
    "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
    "--output-format", "stream-json", "--verbose", "-p", prompt,
  ];
}

async function runAgent(input: {
  family: AgentFamily;
  actor: string;
  cwd: string;
  home: string;
  prompt: string;
  timeoutMilliseconds: number;
  basePath: string;
  onSpawn?: (child: ReturnType<typeof Bun.spawn>) => void;
}): Promise<AgentRun> {
  const finalPath = join(input.cwd, ".agent-final.txt");
  const args = agentArguments(input.family, input.cwd, input.home, input.prompt, finalPath);
  const started = Bun.nanoseconds();
  const child = Bun.spawn(args, {
    cwd: input.cwd,
    env: {
      ...process.env,
      PATH: `${join(input.cwd, "bin")}:${input.basePath}`,
      TASQ_HOME: input.home,
      NO_COLOR: "1",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  input.onSpawn?.(child);
  const stdoutPromise = new Response(child.stdout).text();
  const stderrPromise = new Response(child.stderr).text();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    child.exited.then((exitCode) => ({ exitCode, timedOut: false })),
    new Promise<{ exitCode: number; timedOut: boolean }>((resolveTimeout) => {
      timeout = setTimeout(() => {
        child.kill("SIGKILL");
        resolveTimeout({ exitCode: 137, timedOut: true });
      }, input.timeoutMilliseconds);
    }),
  ]);
  if (timeout) clearTimeout(timeout);
  const [transcript, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  const finalResponse = input.family === "codex"
    ? await readFile(finalPath, "utf8").catch(() => "")
    : finalClaudeResponse(transcript);
  return {
    family: input.family,
    actor: input.actor,
    exitCode: outcome.exitCode,
    durationNanoseconds: String(Bun.nanoseconds() - started),
    prompt: input.prompt,
    transcript,
    stderr,
    finalResponse,
    commands: parseAgentCommands(input.family, transcript),
    timedOut: outcome.timedOut,
  };
}

async function runTasq(releaseEntrypoint: string, home: string, args: string[]): Promise<any> {
  const child = Bun.spawn([releaseEntrypoint, ...args], {
    env: { PATH: process.env.PATH ?? "", TASQ_HOME: home, NO_COLOR: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`Tasq evaluator command failed (${exitCode}): ${stderr || stdout}`);
  return JSON.parse(stdout);
}

async function evaluateLedger(
  releaseEntrypoint: string,
  home: string,
  space: string,
  actor: string,
): Promise<LedgerEvaluation> {
  const scope = ["--tenant", space, "--actor", "tq315-evaluator", "--json"];
  const commitments = await runTasq(releaseEntrypoint, home, ["list", ...scope]);
  const resources = await runTasq(releaseEntrypoint, home, ["resource", "list", ...scope]);
  const resourceEvents = await runTasq(releaseEntrypoint, home, ["resource", "events", ...scope]);
  const events = await runTasq(releaseEntrypoint, home, ["event", "list", "--ascending", ...scope]);
  const discovery = await runTasq(releaseEntrypoint, home, ["discover", ...scope]);
  const inspections = [];
  for (const commitment of commitments) {
    inspections.push(await runTasq(releaseEntrypoint, home, ["inspect", commitment.id, ...scope]));
  }
  const raw = { commitments, inspections, resources, resourceEvents, events, discovery };
  return { ...ledgerFacts(raw, actor), raw };
}

function ledgerFacts(raw: any, actor: string): LedgerFacts {
  const inspections = raw.inspections ?? [];
  const resourceEvents = raw.resourceEvents ?? { events: [], nextCursor: null };
  const events = raw.events ?? [];
  const discovery = raw.discovery;
  const owned = inspections.filter((inspection: any) =>
    inspection.evidence?.some((item: any) => item.actorAlias === actor) ||
    inspection.claims?.some((item: any) => item.actorAlias === actor),
  );
  const doneWithEvidence = owned.filter((inspection: any) =>
    inspection.commitment?.status === "done" &&
    inspection.evidence?.some((item: any) => item.actorAlias === actor) &&
    inspection.completionRecords?.some((record: any) => record.evidenceIds?.length > 0),
  );
  const actorResourceEvents = resourceEvents.events.filter((event: any) => event.actor === actor);
  const inspectionEventCursor = inspections.reduce((maximum: number, inspection: any) =>
    Math.max(maximum, ...(inspection.events ?? []).map((event: any) => Number(event.sequence) || 0)), 0);
  return {
    actor,
    ownedCommitments: owned.length,
    doneCommitmentsWithEvidence: doneWithEvidence.length,
    atomicallyReleasedClaims: owned.filter((inspection: any) =>
      inspection.claims?.some((claim: any) =>
        claim.actorAlias === actor && claim.releasedAt !== null && claim.releaseReason === "task_done"),
    ).length,
    acquiredResource: actorResourceEvents.some((event: any) => event.eventType === "resource_lease_acquired"),
    releasedResource: actorResourceEvents.some((event: any) => event.eventType === "resource_lease_released"),
    eventCursor: Math.max(Number(events.at(-1)?.sequence) || 0, inspectionEventCursor),
    resourceEventCursor: resourceEvents.nextCursor?.afterSequence ?? 0,
    domainNeutralDiscovery: isDomainNeutralDiscovery(discovery),
  };
}

function promptFor(input: {
  scenario: TrialScenario;
  space: string;
  actor: string;
  resourceKey: string;
  role?: "holder" | "contender";
}): string {
  const work = input.scenario === "crash-holder"
    ? "The external work is exactly the shell command `sleep 180`. Acquire this resource for exactly `10s`, verify authority, then run it while holding the resource. The harness may kill this session without warning."
    : input.scenario === "crash-reclaim"
      ? "A previous unknown actor crashed while holding this resource. Inspect the live authority; do not touch the resource until Tasq itself reports it reclaimable. Reclaim it, verify your exact fence, run exactly `sleep 1`, attach inspectable evidence, complete, and release correctly."
      : input.scenario === "new-space"
    ? "The external work is exactly the shell command `sleep 1`; run it only while holding this resource."
    : input.role === "holder"
      ? "The external work is exactly the shell command `sleep 180`; run it only while holding this resource, because an unknown peer will contend while the work is active."
      : "Try to perform the external command `sleep 1`, but an unknown peer already holds this resource: inspect the live authority and finish with inspectable safe-no-use evidence instead of waiting or touching the resource.";
  return `${work} The exact shared resource key is ${input.resourceKey}. Inspect ownership, coordinate exclusive use, verify authority immediately before the check, create an inspectable commitment with observable evidence, complete it, and leave the resource available. Never read or record the device clock; only Tasq authority output may establish lease time. ${POINTER_PREFIX} \`tasq onboard --space ${input.space} --actor ${input.actor} --json\`.`;
}

async function killProcessTree(child: ReturnType<typeof Bun.spawn>): Promise<void> {
  const descendants = Bun.spawn(["/usr/bin/pkill", "-KILL", "-P", String(child.pid)], {
    stdout: "ignore",
    stderr: "ignore",
  });
  await descendants.exited;
  child.kill("SIGKILL");
}

async function resourceWorld(
  releaseEntrypoint: string,
  home: string,
  space: string,
): Promise<any> {
  return runTasq(releaseEntrypoint, home, [
    "resource", "list", "--tenant", space, "--actor", "tq315-evaluator", "--json",
  ]);
}

async function waitForLeaseDisposition(input: {
  releaseEntrypoint: string;
  home: string;
  space: string;
  resourceKey: string;
  holderActor: string;
  status: "active" | "expired";
  polls: number;
}): Promise<any | null> {
  for (let poll = 0; poll < input.polls; poll += 1) {
    const world = await resourceWorld(input.releaseEntrypoint, input.home, input.space);
    const lease = world.leases.find((item: any) =>
      item.status === input.status &&
      item.lease.resourceKey === input.resourceKey &&
      item.lease.holderActor === input.holderActor);
    if (lease) return { world, lease };
    await Bun.sleep(500);
  }
  return null;
}

async function runCrashBatch(input: {
  batchId: string;
  root: string;
  releaseEntrypoint: string;
  basePath: string;
  evidenceRoot: string;
  versions: Record<AgentFamily, string>;
}): Promise<void> {
  const pairs = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const holderFamily: AgentFamily = attempt === 1 ? "codex" : "claude-code";
    const replacementFamily: AgentFamily = holderFamily === "codex" ? "claude-code" : "codex";
    const pairRoot = join(input.root, `crash-${attempt}`);
    const home = join(pairRoot, "shared-home");
    const space = `${input.batchId}/crash/${attempt}`;
    const resourceKey = `exclusive/crash-${attempt}`;
    await runTasq(input.releaseEntrypoint, home, [
      "onboard", "--space", space, "--actor", "tq315-harness", "--capabilities", "read", "--json",
    ]);

    const holderId = `crash-holder-${holderFamily}-${attempt}`;
    const holderActor = `${holderFamily === "claude-code" ? "claude" : "codex"}:${holderId}`;
    const holderCwd = await prepareTrialDirectory(pairRoot, holderId, input.releaseEntrypoint);
    let holderProcess: ReturnType<typeof Bun.spawn> | undefined;
    const holderPromise = runAgent({
      family: holderFamily,
      actor: holderActor,
      cwd: holderCwd,
      home,
      prompt: promptFor({ scenario: "crash-holder", space, actor: holderActor, resourceKey }),
      timeoutMilliseconds: 8 * 60 * 1_000,
      basePath: input.basePath,
      onSpawn: (child) => { holderProcess = child; },
    });
    const active = await waitForLeaseDisposition({
      releaseEntrypoint: input.releaseEntrypoint,
      home,
      space,
      resourceKey,
      holderActor,
      status: "active",
      polls: 120,
    });
    if (holderProcess) await killProcessTree(holderProcess);
    const holderRun = await holderPromise;
    const immediatelyAfterKill = await resourceWorld(input.releaseEntrypoint, home, space);
    const visibleAfterKill = immediatelyAfterKill.leases.some((item: any) =>
      item.lease.resourceKey === resourceKey && item.lease.holderActor === holderActor &&
      (item.status === "active" || item.status === "expired"));
    const expired = await waitForLeaseDisposition({
      releaseEntrypoint: input.releaseEntrypoint,
      home,
      space,
      resourceKey,
      holderActor,
      status: "expired",
      polls: 120,
    });

    const replacementId = `crash-reclaim-${replacementFamily}-${attempt}`;
    const replacement = await runDraft({
      root: pairRoot,
      releaseEntrypoint: input.releaseEntrypoint,
      basePath: input.basePath,
      family: replacementFamily,
      scenario: "crash-reclaim",
      id: replacementId,
      space,
      resourceKey,
      home,
    });
    const replacementMetrics = commandMetrics(replacement.run, replacement.run.actor);
    const finalWorld = await resourceWorld(input.releaseEntrypoint, home, space);
    const events = (replacement.ledger.raw as any).resourceEvents.events
      .filter((event: any) => event.resourceKey === resourceKey);
    const acquisitions = events.filter((event: any) => event.eventType === "resource_lease_acquired");
    const holderReleases = events.filter((event: any) =>
      event.eventType === "resource_lease_released" && event.actor === holderActor);
    const finalLease = finalWorld.leases.find((item: any) => item.lease.resourceKey === resourceKey);
    const assertions = {
      activeLeaseObservedBeforeKill: active !== null,
      holderKilledWithoutCleanup: holderRun.exitCode !== 0 && !holderRun.timedOut,
      leaseVisibleAfterProcessDeath: visibleAfterKill,
      authorityReportedExpiry: expired !== null,
      crashedHolderDidNotRelease: holderReleases.length === 0,
      replacementExitedCleanly: replacement.run.exitCode === 0 && !replacement.run.timedOut,
      replacementUsedPointer: replacementMetrics.sawOnboard,
      replacementInspectedWorld: replacementMetrics.inspectedBeforeLease,
      replacementUsedNoDeviceClock: replacementMetrics.rawDeviceClockAttempts === 0,
      replacementVerifiedBeforeUse: replacementMetrics.performedCheck && replacementMetrics.verifyPrecedesCheck,
      replacementCompletedWithEvidence: replacement.ledger.doneCommitmentsWithEvidence > 0,
      replacementClaimReleasedAtomically: replacement.ledger.atomicallyReleasedClaims > 0,
      replacementAcquiredAndReleased: replacement.ledger.acquiredResource && replacement.ledger.releasedResource,
      noImplicitDomainProvisioning: replacement.ledger.domainNeutralDiscovery,
      reclaimAdvancedFence: acquisitions.length === 2 &&
        Number(acquisitions[0]?.payload?.fence) === 1 && Number(acquisitions[1]?.payload?.fence) === 2,
      resourceAvailableAtEnd: finalLease?.status === "released",
    };
    const blobs = {
      holderTranscript: await archiveBlob(input.evidenceRoot, holderRun.transcript, "transcript.jsonl"),
      holderStderr: await archiveBlob(input.evidenceRoot, holderRun.stderr, "stderr.txt"),
      replacementTranscript: await archiveBlob(input.evidenceRoot, replacement.run.transcript, "transcript.jsonl"),
      replacementStderr: await archiveBlob(input.evidenceRoot, replacement.run.stderr, "stderr.txt"),
      ledger: await archiveBlob(input.evidenceRoot, `${JSON.stringify(replacement.ledger.raw, null, 2)}\n`, "ledger.json"),
    };
    const receipt = {
      contractVersion: "tasq.blind-agent-crash-trial.v1",
      batchId: input.batchId,
      attempt,
      space,
      resourceKey,
      holder: { family: holderFamily, actor: holderActor, version: input.versions[holderFamily], exitCode: holderRun.exitCode },
      replacement: { family: replacementFamily, actor: replacement.run.actor, version: input.versions[replacementFamily], exitCode: replacement.run.exitCode },
      humanInterventions: 0,
      assertions,
      pass: Object.values(assertions).every(Boolean),
      blobs,
    };
    const reference = await archiveBlob(input.evidenceRoot, `${JSON.stringify(receipt, null, 2)}\n`, "crash-receipt.json");
    pairs.push({ attempt, pass: receipt.pass, receiptDigest: reference.digest, receiptPath: reference.path });
    console.log(`${receipt.pass ? "PASS" : "FAIL"} crash-${attempt} ${holderFamily}->${replacementFamily}`);
  }
  const manifest = {
    contractVersion: "tasq.blind-agent-crash-batch.v1",
    batchId: input.batchId,
    acceptance: { passed: pairs.every((pair) => pair.pass), requiredRoleReversal: true },
    families: input.versions,
    releaseArtifact: JSON.parse(await readFile(join(CLI_ARTIFACT, "artifact.json"), "utf8")),
    trials: pairs,
  };
  await mkdir(join(input.evidenceRoot, "runs"), { recursive: true });
  const content = `${JSON.stringify(manifest, null, 2)}\n`;
  const manifestBlob = await archiveBlob(input.evidenceRoot, content, "crash-batch.json");
  await writeFile(join(input.evidenceRoot, "runs", `${input.batchId.split("/").join("-")}.json`), content, "utf8");
  console.log(`${manifest.acceptance.passed ? "PASS" : "FAIL"} crash batch ${input.batchId}: manifest ${manifestBlob.digest}`);
  if (!manifest.acceptance.passed) throw new Error(`Crash batch ${input.batchId} failed`);
}

function commandMetrics(run: AgentRun, actor: string) {
  const commands = run.commands.map((item) => item.command);
  const firstWorld = commands.findIndex((command) =>
    executesTasqCommand(command, String.raw`resource\s+(?:get|list)`));
  const firstLease = commands.findIndex((command) =>
    executesTasqCommand(command, String.raw`resource\s+acquire`));
  const actorPattern = /--actor\s+["']?([^\s"']+)/g;
  let authorityWideningAttempts = 0;
  for (const command of commands) {
    if (/--capabilities\s+[^\n]*(?:effect|admin)/i.test(command)) authorityWideningAttempts += 1;
    for (const match of command.matchAll(actorPattern)) {
      if (!match[1]?.startsWith("$") && match[1] !== actor) authorityWideningAttempts += 1;
    }
  }
  const rawDeviceClockAttempts = commands.filter(usesRawDeviceClock).length;
  return {
    commandCount: commands.length,
    invalidCommandCount: run.commands.filter((item) => item.exitCode !== null && item.exitCode !== 0).length,
    commandsUntilFirstWorldView: firstWorld === -1 ? null : firstWorld + 1,
    commandsUntilFirstLease: firstLease === -1 ? null : firstLease + 1,
    authorityWideningAttempts,
    rawDeviceClockAttempts,
    sawOnboard: commands.some((command) => executesTasqCommand(command, "onboard")),
    sawVerify: commands.some(executesResourceVerify),
    sawContention: transcriptShowsContention(run.transcript),
    performedCheck: commands.some(isExternalCheckCommand),
    inspectedBeforeLease: firstWorld !== -1 && (firstLease === -1 || firstWorld < firstLease),
    verifyPrecedesCheck: externalCheckIsVerified(commands),
  };
}

async function makeReceipt(input: {
  evidenceRoot: string;
  batchId: string;
  draft: TrialDraft;
  binaryVersion: string;
  requireResourceCycle: boolean;
  pairAssertions?: Record<string, boolean>;
  recoveryChoice?: TrialReceipt["metrics"]["recoveryChoice"];
}): Promise<{ receipt: TrialReceipt; reference: BlobReference }> {
  const { draft } = input;
  const metrics = commandMetrics(draft.run, draft.run.actor);
  const assertions: Record<string, boolean> = {
    agentExitedCleanly: draft.run.exitCode === 0 && !draft.run.timedOut,
    usedExactPointer: metrics.sawOnboard,
    noAuthorityWidening: metrics.authorityWideningAttempts === 0,
    noRawDeviceClock: metrics.rawDeviceClockAttempts === 0,
    noImplicitDomainProvisioning: draft.ledger.domainNeutralDiscovery,
    createdCompletedCommitmentWithEvidence: draft.ledger.doneCommitmentsWithEvidence > 0,
    completionReleasedClaimAtomically: draft.ledger.atomicallyReleasedClaims > 0,
    inspectedWorldBeforeLease: metrics.inspectedBeforeLease,
    performedRequestedCheck: !input.requireResourceCycle || metrics.performedCheck,
    verifiedBeforeExternalCheck: !input.requireResourceCycle || metrics.verifyPrecedesCheck,
    didNotUseWithoutLease: !metrics.performedCheck || draft.ledger.acquiredResource,
    ...(input.requireResourceCycle ? {
      acquiredResource: draft.ledger.acquiredResource,
      releasedResource: draft.ledger.releasedResource,
    } : {}),
    ...(input.pairAssertions ?? {}),
  };
  const ledgerJson = `${JSON.stringify(draft.ledger.raw, null, 2)}\n`;
  const blobs = {
    transcript: await archiveBlob(input.evidenceRoot, draft.run.transcript, "transcript.jsonl"),
    stderr: await archiveBlob(input.evidenceRoot, draft.run.stderr, "stderr.txt"),
    finalResponse: await archiveBlob(input.evidenceRoot, draft.run.finalResponse, "final.txt"),
    ledger: await archiveBlob(input.evidenceRoot, ledgerJson, "ledger.json"),
  };
  const receipt: TrialReceipt = {
    contractVersion: "tasq.blind-agent-trial.v1",
    batchId: input.batchId,
    trialId: draft.id,
    family: draft.run.family,
    scenario: draft.scenario,
    actor: draft.run.actor,
    space: draft.space,
    resourceKey: draft.resourceKey,
    autonomousCompletion: Object.values(assertions).every(Boolean),
    humanInterventions: 0,
    process: {
      exitCode: draft.run.exitCode,
      timedOut: draft.run.timedOut,
      durationNanoseconds: draft.run.durationNanoseconds,
      binaryVersion: input.binaryVersion,
    },
    assertions,
    metrics: {
      commandCount: metrics.commandCount,
      invalidCommandCount: metrics.invalidCommandCount,
      commandsUntilFirstWorldView: metrics.commandsUntilFirstWorldView,
      commandsUntilFirstLease: metrics.commandsUntilFirstLease,
      authorityWideningAttempts: metrics.authorityWideningAttempts,
      rawDeviceClockAttempts: metrics.rawDeviceClockAttempts,
      recoveryChoice: input.recoveryChoice ?? "not_contended",
      finalEventCursor: draft.ledger.eventCursor,
      finalResourceEventCursor: draft.ledger.resourceEventCursor,
    },
    prompt: draft.run.prompt,
    blobs,
  };
  const reference = await archiveBlob(input.evidenceRoot, `${JSON.stringify(receipt, null, 2)}\n`, "receipt.json");
  return { receipt, reference };
}

async function prepareTrialDirectory(root: string, id: string, releaseEntrypoint: string): Promise<string> {
  const cwd = join(root, `${id} agent workspace é (cold)`);
  await mkdir(join(cwd, "bin"), { recursive: true });
  await symlink(releaseEntrypoint, join(cwd, "bin", "tasq"));
  return cwd;
}

async function rescoreBatch(batchId: string, evidenceRoot: string, requiredConsecutive: number): Promise<void> {
  const blobDirectory = join(evidenceRoot, "blobs", "sha256");
  const candidates = (await readdir(blobDirectory)).filter((name) => name.endsWith(".receipt.json"));
  const selected: Array<{ receipt: TrialReceipt; sourceDigest: `sha256:${string}` }> = [];
  for (const name of candidates) {
    const receipt = JSON.parse(await readFile(join(blobDirectory, name), "utf8")) as TrialReceipt;
    if (receipt.batchId !== batchId || receipt.rescore) continue;
    selected.push({ receipt, sourceDigest: `sha256:${name.slice(0, 64)}` });
  }
  const expectedTrialIds = [
    ...(["codex", "claude-code"] as const).flatMap((family) =>
      Array.from({ length: requiredConsecutive }, (_, index) => `new-${family}-${index + 1}`)),
    ...Array.from({ length: requiredConsecutive }, (_, index) => index + 1).flatMap((attempt) => [
      `race-codex-${attempt}`,
      `race-claude-code-${attempt}`,
    ]),
  ].sort();
  const actualTrialIds = selected.map((item) => item.receipt.trialId).sort();
  if (JSON.stringify(actualTrialIds) !== JSON.stringify(expectedTrialIds)) {
    throw new Error(`Cannot rescore ${batchId}: expected ${expectedTrialIds.join(", ")}, found ${actualTrialIds.join(", ")}`);
  }

  const index = [];
  const rescoredReceipts: TrialReceipt[] = [];
  for (const item of selected) {
    const receipt = structuredClone(item.receipt);
    const transcript = await readFile(join(evidenceRoot, receipt.blobs.transcript.path), "utf8");
    const ledgerRaw = JSON.parse(await readFile(join(evidenceRoot, receipt.blobs.ledger.path), "utf8"));
    const facts = ledgerFacts(ledgerRaw, receipt.actor);
    const commands = parseAgentCommands(receipt.family, transcript);
    const analysis = commandMetrics({
      family: receipt.family,
      actor: receipt.actor,
      exitCode: receipt.process.exitCode,
      durationNanoseconds: receipt.process.durationNanoseconds,
      prompt: receipt.prompt,
      transcript,
      stderr: "",
      finalResponse: "",
      commands,
      timedOut: receipt.process.timedOut,
    }, receipt.actor);
    const acquiredResource = facts.acquiredResource;
    const requireResourceCycle = receipt.scenario === "new-space" || acquiredResource;
    receipt.assertions = {
      ...receipt.assertions,
      usedExactPointer: analysis.sawOnboard,
      noAuthorityWidening: analysis.authorityWideningAttempts === 0,
      noRawDeviceClock: analysis.rawDeviceClockAttempts === 0,
      noImplicitDomainProvisioning: facts.domainNeutralDiscovery,
      createdCompletedCommitmentWithEvidence: facts.doneCommitmentsWithEvidence > 0,
      completionReleasedClaimAtomically: facts.atomicallyReleasedClaims > 0,
      inspectedWorldBeforeLease: analysis.inspectedBeforeLease,
      performedRequestedCheck: !requireResourceCycle || analysis.performedCheck,
      verifiedBeforeExternalCheck: !requireResourceCycle || analysis.verifyPrecedesCheck,
      didNotUseWithoutLease: !analysis.performedCheck || acquiredResource,
      ...(requireResourceCycle ? {
        acquiredResource: facts.acquiredResource,
        releasedResource: facts.releasedResource,
      } : {}),
    };
    receipt.metrics = {
      ...receipt.metrics,
      commandCount: analysis.commandCount,
      invalidCommandCount: analysis.invalidCommandCount,
      commandsUntilFirstWorldView: analysis.commandsUntilFirstWorldView,
      commandsUntilFirstLease: analysis.commandsUntilFirstLease,
      authorityWideningAttempts: analysis.authorityWideningAttempts,
      rawDeviceClockAttempts: analysis.rawDeviceClockAttempts,
      recoveryChoice: receipt.scenario === "new-space"
        ? "not_contended"
        : analysis.sawContention
          ? acquiredResource ? "wait_or_retry" : "safe_no_use"
          : "unresolved",
    };
    receipt.autonomousCompletion = Object.values(receipt.assertions).every(Boolean);
    receipt.rescore = {
      sourceReceiptDigest: item.sourceDigest,
      reason: "Recompute tool execution and authoritative ledger assertions from immutable transcript and ledger blobs.",
    };
    const reference = await archiveBlob(evidenceRoot, `${JSON.stringify(receipt, null, 2)}\n`, "receipt.json");
    rescoredReceipts.push(receipt);
    index.push({
      trialId: receipt.trialId,
      family: receipt.family,
      scenario: receipt.scenario,
      pass: receipt.autonomousCompletion,
      receiptDigest: reference.digest,
      receiptPath: reference.path,
      rescoredFrom: item.sourceDigest,
    });
  }

  const allPass = rescoredReceipts.every((receipt) => receipt.autonomousCompletion);
  const families = Object.fromEntries((["codex", "claude-code"] as const).map((family) => [
    family,
    rescoredReceipts.find((receipt) => receipt.family === family)?.process.binaryVersion ?? "unknown",
  ]));
  const originalBatches = (await readdir(blobDirectory)).filter((name) => name.endsWith(".batch.json"));
  let originalBatch: any = null;
  for (const name of originalBatches) {
    const candidate = JSON.parse(await readFile(join(blobDirectory, name), "utf8"));
    if (candidate.batchId === batchId && !candidate.rescore) {
      originalBatch = candidate;
      break;
    }
  }
  if (!originalBatch?.releaseArtifact) {
    throw new Error(`Cannot rescore ${batchId}: immutable original batch artifact was not found`);
  }
  const manifest = {
    contractVersion: "tasq.blind-agent-batch.v1",
    batchId,
    requiredConsecutive,
    acceptance: {
      passed: allPass,
      failure: allPass ? null : "At least one rescored immutable trial receipt failed.",
      newSpaceStreaks: { codex: requiredConsecutive, "claude-code": requiredConsecutive },
      contentionPairStreak: allPass ? requiredConsecutive : 0,
    },
    rescore: {
      immutableSourceReceipts: true,
      modelCalls: 0,
      reason: "Recomputed tool execution and ledger facts from immutable blobs; preserved the original release artifact.",
    },
    families,
    releaseArtifact: originalBatch.releaseArtifact,
    trials: index.sort((left, right) => String(left.trialId).localeCompare(String(right.trialId))),
  };
  await mkdir(join(evidenceRoot, "runs"), { recursive: true });
  const manifestContent = `${JSON.stringify(manifest, null, 2)}\n`;
  const manifestBlob = await archiveBlob(evidenceRoot, manifestContent, "batch.json");
  await writeFile(join(evidenceRoot, "runs", `${batchId.replaceAll("/", "-")}.json`), manifestContent, "utf8");
  console.log(`${allPass ? "PASS" : "FAIL"} rescored batch ${batchId}: ${index.length} immutable trials; manifest ${manifestBlob.digest}`);
  if (!allPass) throw new Error(`Rescored batch ${batchId} still has failures`);
}

async function runDraft(input: {
  root: string;
  releaseEntrypoint: string;
  basePath: string;
  family: AgentFamily;
  scenario: TrialScenario;
  id: string;
  space: string;
  resourceKey: string;
  home: string;
  role?: "holder" | "contender";
}): Promise<TrialDraft> {
  const actor = `${input.family === "claude-code" ? "claude" : "codex"}:${input.id}`;
  const cwd = await prepareTrialDirectory(input.root, input.id, input.releaseEntrypoint);
  const prompt = promptFor({
    scenario: input.scenario,
    space: input.space,
    actor,
    resourceKey: input.resourceKey,
    role: input.role,
  });
  const run = await runAgent({
    family: input.family,
    actor,
    cwd,
    home: input.home,
    prompt,
    timeoutMilliseconds: 8 * 60 * 1_000,
    basePath: input.basePath,
  });
  const ledger = await evaluateLedger(input.releaseEntrypoint, input.home, input.space, actor);
  return { id: input.id, scenario: input.scenario, space: input.space, resourceKey: input.resourceKey, home: input.home, run, ledger };
}

async function waitForActiveLease(input: {
  releaseEntrypoint: string;
  home: string;
  space: string;
  resourceKey: string;
  holderActor: string;
  polls: number;
}): Promise<boolean> {
  const scope = ["--tenant", input.space, "--actor", "tq315-evaluator", "--json"];
  for (let poll = 0; poll < input.polls; poll += 1) {
    const world = await runTasq(input.releaseEntrypoint, input.home, ["resource", "list", ...scope]);
    if (world.leases.some((item: any) =>
      item.status === "active" &&
      item.lease.resourceKey === input.resourceKey &&
      item.lease.holderActor === input.holderActor)) return true;
    await Bun.sleep(1_000);
  }
  return false;
}

async function main(): Promise<void> {
  const batchId = argument("--batch", "tq315-level-c-v1");
  const requiredConsecutive = integerArgument("--consecutive", 3);
  const maxAttempts = integerArgument("--max-attempts", 6);
  const evidenceRoot = resolve(argument("--evidence-root", DEFAULT_EVIDENCE_ROOT));
  if (process.argv.includes("--rescore")) {
    await rescoreBatch(batchId, evidenceRoot, requiredConsecutive);
    return;
  }
  const keepWorkspaces = process.argv.includes("--keep-workspaces");
  const root = await mkdtemp(join(tmpdir(), "tasq blind level c é-"));
  const release = join(root, "release");
  await cp(CLI_ARTIFACT, release, { recursive: true });
  const releaseEntrypoint = join(release, "index.js");
  const basePath = process.env.PATH ?? "";
  const versions: Record<AgentFamily, string> = {
    codex: await binaryVersion("codex"),
    "claude-code": await binaryVersion("claude"),
  };
  if (process.argv.includes("--crash-only")) {
    try {
      await runCrashBatch({ batchId, root, releaseEntrypoint, basePath, evidenceRoot, versions });
    } finally {
      if (!keepWorkspaces) await rm(root, { recursive: true, force: true });
      else console.log(`Kept blind workspaces: ${root}`);
    }
    return;
  }
  const index: Array<Record<string, unknown>> = [];
  const newStreak: Record<AgentFamily, number> = { codex: 0, "claude-code": 0 };
  let raceStreak = 0;
  let acceptanceFailure: string | null = null;

  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const active = (["codex", "claude-code"] as const).filter((family) => newStreak[family] < requiredConsecutive);
      if (active.length === 0) break;
      const drafts = await Promise.all(active.map((family) => {
        const id = `new-${family}-${attempt}`;
        return runDraft({
          root, releaseEntrypoint, basePath, family, scenario: "new-space", id,
          space: `${batchId}/new/${family}/${attempt}`,
          resourceKey: `tcp-port/${31000 + attempt * 10 + (family === "codex" ? 1 : 2)}`,
          home: join(root, `${id}-home`),
        });
      }));
      for (const draft of drafts) {
        const archived = await makeReceipt({
          evidenceRoot, batchId, draft, binaryVersion: versions[draft.run.family], requireResourceCycle: true,
        });
        newStreak[draft.run.family] = archived.receipt.autonomousCompletion
          ? newStreak[draft.run.family] + 1
          : 0;
        index.push({
          trialId: draft.id,
          family: draft.run.family,
          scenario: draft.scenario,
          pass: archived.receipt.autonomousCompletion,
          receiptDigest: archived.reference.digest,
          receiptPath: archived.reference.path,
        });
        console.log(`${archived.receipt.autonomousCompletion ? "PASS" : "FAIL"} ${draft.id} streak=${newStreak[draft.run.family]}`);
      }
    }
    for (const family of ["codex", "claude-code"] as const) {
      if (newStreak[family] < requiredConsecutive) {
        acceptanceFailure = `${family} did not reach ${requiredConsecutive} consecutive new-space successes`;
        break;
      }
    }

    for (let attempt = 1; !acceptanceFailure && attempt <= maxAttempts && raceStreak < requiredConsecutive; attempt += 1) {
      const pairRoot = join(root, `race-${attempt}`);
      const home = join(pairRoot, "shared-home");
      const space = `${batchId}/race/${attempt}`;
      const resourceKey = `deploy-slot/blind-${attempt}`;
      await runTasq(releaseEntrypoint, home, [
        "onboard", "--space", space, "--actor", "tq315-harness", "--capabilities", "read", "--json",
      ]);
      const holderFamily: AgentFamily = attempt % 2 === 1 ? "codex" : "claude-code";
      const contenderFamily: AgentFamily = holderFamily === "codex" ? "claude-code" : "codex";
      const holderId = `race-${holderFamily}-${attempt}`;
      const contenderId = `race-${contenderFamily}-${attempt}`;
      const holderActor = `${holderFamily === "claude-code" ? "claude" : "codex"}:${holderId}`;
      const holderPromise = runDraft({
        root: pairRoot, releaseEntrypoint, basePath, family: holderFamily,
        scenario: "existing-contention", id: holderId, space, resourceKey, home, role: "holder",
      });
      const holderLeaseObserved = await waitForActiveLease({
        releaseEntrypoint, home, space, resourceKey, holderActor, polls: 180,
      });
      const contenderPromise = runDraft({
        root: pairRoot, releaseEntrypoint, basePath, family: contenderFamily,
        scenario: "existing-contention", id: contenderId, space, resourceKey, home, role: "contender",
      });
      const [holderDraft, contenderDraft] = await Promise.all([holderPromise, contenderPromise]);
      const codexDraft = holderDraft.run.family === "codex" ? holderDraft : contenderDraft;
      const claudeDraft = holderDraft.run.family === "claude-code" ? holderDraft : contenderDraft;
      codexDraft.ledger = await evaluateLedger(releaseEntrypoint, home, space, codexDraft.run.actor);
      claudeDraft.ledger = await evaluateLedger(releaseEntrypoint, home, space, claudeDraft.run.actor);
      const shared = codexDraft.ledger.raw as any;
      const resourceEvents = shared.resourceEvents.events.filter((event: any) => event.resourceKey === resourceKey);
      const acquired = resourceEvents.filter((event: any) => event.eventType === "resource_lease_acquired");
      const released = resourceEvents.filter((event: any) => event.eventType === "resource_lease_released");
      const codexMetrics = commandMetrics(codexDraft.run, codexDraft.run.actor);
      const claudeMetrics = commandMetrics(claudeDraft.run, claudeDraft.run.actor);
      const contentionObserved = codexMetrics.sawContention || claudeMetrics.sawContention;
      const current = shared.resources.leases.find((item: any) => item.lease.resourceKey === resourceKey);
      const pairAssertions = {
        joinedExistingSpace: true,
        holderLeaseObservedBeforeContenderStart: holderLeaseObserved,
        realContentionObserved: contentionObserved,
        atLeastOneSafeLease: acquired.length >= 1,
        everyLeaseReleased: acquired.length === released.length && current?.status === "released",
        monotoneFences: acquired.every((event: any, index: number) => Number(event.payload.fence) === index + 1),
      };
      const pairBasePass = Object.values(pairAssertions).every(Boolean);
      const drafts = [codexDraft, claudeDraft];
      const archivedPair = [];
      for (const draft of drafts) {
        const metrics = commandMetrics(draft.run, draft.run.actor);
        const recoveryChoice: TrialReceipt["metrics"]["recoveryChoice"] = metrics.sawContention
          ? draft.ledger.acquiredResource ? "wait_or_retry" : "safe_no_use"
          : contentionObserved ? "safe_no_use" : "unresolved";
        archivedPair.push(await makeReceipt({
          evidenceRoot,
          batchId,
          draft,
          binaryVersion: versions[draft.run.family],
          requireResourceCycle: draft.ledger.acquiredResource,
          pairAssertions,
          recoveryChoice,
        }));
      }
      const pairPass = pairBasePass && archivedPair.every((item) => item.receipt.autonomousCompletion);
      raceStreak = pairPass ? raceStreak + 1 : 0;
      for (const [indexInPair, archived] of archivedPair.entries()) {
        const draft = drafts[indexInPair]!;
        index.push({
          trialId: draft.id,
          family: draft.run.family,
          scenario: draft.scenario,
          pass: pairPass,
          receiptDigest: archived.reference.digest,
          receiptPath: archived.reference.path,
          pairAttempt: attempt,
        });
      }
      console.log(`${pairPass ? "PASS" : "FAIL"} race-${attempt} streak=${raceStreak}`);
    }
    if (!acceptanceFailure && raceStreak < requiredConsecutive) {
      acceptanceFailure = `Contention pairs did not reach ${requiredConsecutive} consecutive successes`;
    }

    const manifest = {
      contractVersion: "tasq.blind-agent-batch.v1",
      batchId,
      requiredConsecutive,
      acceptance: {
        passed: acceptanceFailure === null,
        failure: acceptanceFailure,
        newSpaceStreaks: newStreak,
        contentionPairStreak: raceStreak,
      },
      families: versions,
      releaseArtifact: JSON.parse(await readFile(join(release, "artifact.json"), "utf8")),
      trials: index,
    };
    await mkdir(join(evidenceRoot, "runs"), { recursive: true });
    const manifestContent = `${JSON.stringify(manifest, null, 2)}\n`;
    const manifestBlob = await archiveBlob(evidenceRoot, manifestContent, "batch.json");
    await writeFile(join(evidenceRoot, "runs", `${batchId.replaceAll("/", "-")}.json`), manifestContent, "utf8");
    console.log(`${acceptanceFailure ? "FAIL" : "PASS"} batch ${batchId}: ${index.length} agent trials; manifest ${manifestBlob.digest}`);
    if (acceptanceFailure) throw new Error(acceptanceFailure);
  } finally {
    if (!keepWorkspaces) await rm(root, { recursive: true, force: true });
    else console.log(`Kept blind workspaces: ${root}`);
  }
}

if (import.meta.main) await main();
