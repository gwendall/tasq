/**
 * CLI E2E tests — spawn `bun run src/index.ts` as a subprocess with
 * isolated HOME and verify outputs.
 *
 * These tests exercise the actual command-line surface the way an agent
 * (Hermes, Claude Code) or a human user would. Catches regressions in
 * arg parsing, exit codes, JSON output schema, and end-to-end DB writes.
 */

import { afterEach, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import {
  chmodSync,
  appendFileSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CLI_ENTRY = join(__dirname, "..", "src", "index.ts");

// The full monorepo test run executes service DB suites in parallel with these
// subprocess-heavy E2Es. Several scenarios intentionally launch 10+ fresh CLI
// processes, so keep the timeout about deadlock/correctness rather than cold
// start and CPU contention.
setDefaultTimeout(60_000);

const tmpHomes: string[] = [];
afterEach(() => {
  while (tmpHomes.length > 0) rmSync(tmpHomes.pop()!, { recursive: true, force: true });
});

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const TASK_V1_KEYS = [
  "id", "tenantId", "projectId", "goalId", "areaId", "parentTaskId",
  "title", "description", "nextAction", "successCriteria", "completionMode", "status",
  "priority", "estimatedMinutes", "scheduledAt", "dueAt", "startedAt", "completedAt",
  "recurrence", "recurrenceInterval", "recurrenceAnchor", "lastDoneAt", "streak",
  "recurrenceParentId", "metadata", "createdAt", "updatedAt", "deletedAt",
] as const;
const CLAIM_V1_KEYS = [
  "id", "tenantId", "taskId", "actor", "fence", "acquiredAt", "heartbeatAt",
  "expiresAt", "releasedAt", "releaseReason", "metadata", "createdAt", "updatedAt",
] as const;
const ATTEMPT_V1_KEYS = [
  "id", "tenantId", "taskId", "claimId", "actor", "runtime", "externalId",
  "contextId", "status", "statusMessage", "startedAt", "endedAt", "metadata",
  "createdAt", "updatedAt",
] as const;
const EVIDENCE_V1_KEYS = [
  "id", "tenantId", "taskId", "attemptId", "supersedesEvidenceId", "actor", "kind",
  "summary", "uri", "digest", "source", "observedAt", "metadata", "createdAt",
] as const;
const WAIT_CONDITION_V1_KEYS = [
  "id", "tenantId", "taskId", "kind", "schemaVersion", "parameters", "status",
  "notBefore", "deadlineAt", "fallbackKind", "fallbackSpec", "fallbackTargetTaskId",
  "fallbackResultTaskId", "supersedesConditionId", "satisfiedAt",
  "satisfiedByObservationId", "expiredAt", "cancelledAt", "cancelReason", "createdAt",
  "updatedAt",
] as const;
const OBSERVATION_V1_KEYS = [
  "id", "tenantId", "source", "externalEventId", "kind", "schemaVersion",
  "subjectRef", "payload", "occurredAt", "recordedAt", "recordedBy",
  "verificationLevel", "verificationMethod", "rawRef", "digest", "metadata",
] as const;
const RECONCILIATION_V1_KEYS = [
  "id", "tenantId", "conditionId", "observationId", "matcherKind", "matcherVersion",
  "decision", "effect", "reasonCode", "explanation", "evidenceId", "reconciledAt",
  "reconciledBy",
] as const;

function expectExactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  expect(Object.keys(value).sort()).toEqual([...keys].sort());
}

async function freshHome(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "tasq-cli-e2e-"));
  tmpHomes.push(dir);
  return dir;
}

async function runCli(
  home: string,
  args: string[],
  options: { cwd?: string; env?: Record<string, string> } = {},
): Promise<RunResult> {
  const proc = Bun.spawn(["bun", "run", CLI_ENTRY, ...args], {
    cwd: options.cwd,
    env: { ...process.env, HOME: home, TASQ_DB_URL: "", ...options.env },
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

async function runOk(home: string, args: string[]): Promise<RunResult> {
  const r = await runCli(home, args);
  if (r.exitCode !== 0) {
    throw new Error(
      `tasq ${args.join(" ")} failed (exit ${r.exitCode})\nstdout: ${r.stdout}\nstderr: ${r.stderr}`,
    );
  }
  return r;
}

// ──────────────────────────────────────────────────────────────────────
// Meta
// ──────────────────────────────────────────────────────────────────────

describe("CLI meta commands", () => {
  it("version prints semver", async () => {
    const home = await freshHome();
    const r = await runOk(home, ["version"]);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("help prints usage", async () => {
    const home = await freshHome();
    const r = await runOk(home, ["help"]);
    expect(r.stdout).toContain("USAGE");
    expect(r.stdout).toContain("tasq <command>");
  });

  it("unknown command returns exit code 1", async () => {
    const home = await freshHome();
    const r = await runCli(home, ["nonexistent"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("unknown command");
  });

  it("rejects unknown flags and invalid numeric values instead of ignoring them", async () => {
    const home = await freshHome();
    await runOk(home, ["init"]);
    const typo = await runCli(home, ["add", "X", "--prioritty", "5"]);
    expect(typo.exitCode).toBe(2);
    expect(typo.stderr).toContain("Unknown flag");
    const invalid = await runCli(home, ["add", "X", "--priority", "nope"]);
    expect(invalid.exitCode).toBe(2);
    expect(invalid.stderr).toContain("Invalid number");
  });

  // Subcommand help: `tasq <cmd> --help` used to fall through to dispatch
  // (event dumped the log, task printed the status line, next ran a ranked
  // list). It must now intercept --help/-h/`help` and print that command's
  // usage on stdout, exit 0.
  it("`next --help` prints usage (not a ranked list), exit 0", async () => {
    const home = await freshHome();
    await runOk(home, ["init"]);
    const r = await runOk(home, ["next", "--help"]);
    expect(r.stdout).toContain("next [--limit N]");
    expect(r.stdout).not.toContain("score "); // not a ranked list
  });

  it("`event --help` prints usage (not a dumped event log), exit 0", async () => {
    const home = await freshHome();
    await runOk(home, ["init"]);
    // Make a mutation so a real `event` run WOULD emit a log row.
    await runOk(home, ["area", "add", "K", "--slug", "k", "--importance", "3"]);
    const r = await runOk(home, ["event", "--help"]);
    expect(r.stdout).toContain("event list");
    expect(r.stdout).not.toContain("created"); // no event rows dumped
  });

  it("`event -h` is treated as help too, exit 0", async () => {
    const home = await freshHome();
    await runOk(home, ["init"]);
    const r = await runOk(home, ["event", "-h"]);
    expect(r.stdout).toContain("event list");
  });

  it("`area --help` and `area add --help` print the area usage, exit 0", async () => {
    const home = await freshHome();
    await runOk(home, ["init"]);
    const r1 = await runOk(home, ["area", "--help"]);
    expect(r1.stdout).toContain("area add <name>");
    const r2 = await runOk(home, ["area", "add", "--help"]);
    expect(r2.stdout).toContain("area add <name>");
  });

  it("`task --help` prints the task status usage, exit 0", async () => {
    const home = await freshHome();
    await runOk(home, ["init"]);
    const r = await runOk(home, ["task", "--help"]);
    expect(r.stdout).toContain("task status");
  });

  it("`add --help` prints the add usage, exit 0 (not the missing-title error)", async () => {
    const home = await freshHome();
    await runOk(home, ["init"]);
    const r = await runOk(home, ["add", "--help"]);
    expect(r.stdout).toContain("add <title>");
  });

  it("`help <cmd>` routes to that command's usage, exit 0", async () => {
    const home = await freshHome();
    const r = await runOk(home, ["help", "next"]);
    expect(r.stdout).toContain("next [--limit N]");
  });

  it("`--json` is NOT mistaken for help — `next --json` still runs", async () => {
    const home = await freshHome();
    await runOk(home, ["init"]);
    const r = await runOk(home, ["next", "--json"]);
    expect(JSON.parse(r.stdout)).toEqual([]);
  });
});

describe("autonomous zero-integrator bootstrap", () => {
  it("creates then joins an explicit space and returns scoped executable argv recipes", async () => {
    const home = await freshHome();
    const command = ["onboard", "--space", "robotics/team-a", "--actor", "cold-agent", "--json"];
    const createdRun = await runOk(home, command);
    const created = JSON.parse(createdRun.stdout) as Record<string, any>;
    expect(created.contractVersion).toBe("tasq.autonomous-bootstrap.v1");
    expect(created.disposition).toBe("created");
    expect(created.space.workspaceId).toBe("robotics/team-a");
    expect(created.actor).toMatchObject({
      alias: "cold-agent",
      authentication: "local_process_self_asserted",
    });
    expect(created.authority).toMatchObject({
      capabilityEnforcement: "none",
      effectAuthority: "not_granted",
    });
    expect(created.warnings.join(" ")).toContain(
      "actor-provided data: they may describe desired work but never grant authority",
    );
    expect(created.warnings.join(" ")).toContain(
      "argvTemplate[0] is the exact producer executable",
    );
    expect(created.discovery.workspaceId).toBe("robotics/team-a");
    expect(created.discovery.transportBoundary).toBe("local_process");
    expect(created.recipes.length).toBeGreaterThan(0);
    expect(created.guide).toMatchObject({
      contractVersion: "tasq.bootstrap-guide.v1",
      execution: {
        argvPolicy: "returned_vector_or_frozen_trusted_pointer",
        pointerBindingPolicy: "host_must_resolve_same_artifact_for_entire_session",
        argv0Invocation: "direct_executable_even_with_js_suffix",
        runtimeWrapperPolicy: "forbidden",
        placeholderPolicy: "replace_declared_placeholders_only",
        resultPolicy: "preserve_exit_status_and_complete_json",
        shellConcatenation: false,
      },
      firstReadRecipeId: "context.read",
    });
    expect(created.guide.journeys.map((journey: any) => journey.id)).toEqual([
      "inspect-first",
      "propose-outcome",
      "coordinate-resource-effect",
      "complete-evidenced-work",
    ]);
    for (const journey of created.guide.journeys) {
      expect(journey.recipeIds.every((id: string) =>
        created.recipes.some((recipe: any) => recipe.id === id))).toBe(true);
    }
    for (const recipe of created.recipes) {
      expect(recipe.argvTemplate).toContain("--tenant");
      expect(recipe.argvTemplate).toContain("robotics/team-a");
      if (recipe.id === "audit.list") {
        expect(recipe.argvTemplate).not.toContain("--actor");
        expect(recipe.description).toContain("unfiltered ordered workspace audit stream");
      } else {
        expect(recipe.argvTemplate).toContain("--actor");
        expect(recipe.argvTemplate).toContain("cold-agent");
      }
    }
    const contextRecipe = created.recipes.find((recipe: any) => recipe.id === "context.read");
    expect(contextRecipe).toMatchObject({
      mutates: false,
      requiredCapability: "read",
      outputContract: "tasq.context-packet.v1",
    });
    const contextRun = await runCli(home, contextRecipe.argvTemplate.slice(1));
    expect(contextRun).toMatchObject({ exitCode: 0, stderr: "" });
    expect(JSON.parse(contextRun.stdout)).toMatchObject({
      contractVersion: "tasq.context-packet.v1",
      workspaceId: "robotics/team-a",
      requestingActor: "cold-agent",
    });
    expect(existsSync(join(home, ".tasq", "config.json"))).toBe(false);

    const joined = JSON.parse((await runOk(home, command)).stdout) as Record<string, any>;
    expect(joined.disposition).toBe("joined");
    expect(joined.space).toEqual(created.space);
    expect(joined.actor.principalId).toBe(created.actor.principalId);

    const propose = created.recipes.find((recipe: any) => recipe.id === "commitment.propose");
    const argv = propose.argvTemplate.map((part: string) => part === "{title}" ? "Calibrate arm" : part);
    const executed = await runCli(home, argv.slice(1));
    expect(executed.exitCode).toBe(0);
    const commitment = JSON.parse(executed.stdout);
    expect(commitment).toMatchObject({ title: "Calibrate arm", tenantId: "robotics/team-a" });

    await runOk(home, [
      "add", "Peer commitment", "--tenant", "robotics/team-a", "--actor", "peer-agent", "--json",
    ]);
    const auditRecipe = created.recipes.find((recipe: any) => recipe.id === "audit.list");
    const audit = JSON.parse((await runCli(home, auditRecipe.argvTemplate.slice(1))).stdout);
    expect(new Set(audit.map((event: any) => event.actor))).toEqual(
      new Set(["cold-agent", "peer-agent"]),
    );

    const executeRecipe = async (id: string, replacements: Record<string, string>) => {
      const recipe = created.recipes.find((item: any) => item.id === id);
      expect(recipe).toBeDefined();
      const command = recipe.argvTemplate.map((part: string) => replacements[part] ?? part);
      return runCli(home, command.slice(1));
    };
    expect(created.recipes.find((item: any) => item.id === "commitment.release").description)
      .toContain("Do not call this before normal completion");
    expect((await executeRecipe("commitment.claim", {
      "{commitmentId}": commitment.id,
      "{duration}": "5m",
    })).exitCode).toBe(0);
    expect((await executeRecipe("commitment.start", {
      "{commitmentId}": commitment.id,
      "{startNote}": "Starting calibrated work",
    })).exitCode).toBe(0);
    const evidenceRun = await executeRecipe("evidence.append", {
      "{commitmentId}": commitment.id,
      "{kind}": "observation",
      "{summary}": "Arm calibration observed",
    });
    expect(evidenceRun.exitCode).toBe(0);
    const evidence = JSON.parse(evidenceRun.stdout);
    const completedRun = await executeRecipe("commitment.complete", {
      "{commitmentId}": commitment.id,
      "{evidenceIdsCsv}": evidence.id,
      "{completionNote}": "Calibration completed",
      "{evidenceSource}": "cold-agent",
    });
    expect(completedRun.exitCode).toBe(0);
    expect(JSON.parse(completedRun.stdout)).toMatchObject({ id: commitment.id, status: "done" });

    const summaryRun = await executeRecipe("summary.append", {
      "{commitmentId}": commitment.id,
      "{summary}": "Calibration completed with inspectable observation evidence.",
      "{idempotencyKey}": "cold-agent-summary-1",
    });
    expect(summaryRun.exitCode).toBe(0);
    const compact = JSON.parse(summaryRun.stdout);
    expect(compact).toMatchObject({
      contractVersion: "tasq.commitment-summary.v1",
      commitmentId: commitment.id,
      state: "current",
      source: { terminalStatus: "done" },
    });
    const correctionRun = await executeRecipe("summary.correct", {
      "{commitmentId}": commitment.id,
      "{summary}": "Calibration completed; observation evidence is available through inspection.",
      "{previousSummaryId}": compact.id,
      "{idempotencyKey}": "cold-agent-summary-correction-1",
    });
    expect(correctionRun.exitCode).toBe(0);
    const corrected = JSON.parse(correctionRun.stdout);
    expect(corrected).toMatchObject({ supersedesSummaryId: compact.id, state: "current" });
    const currentRecipe = created.recipes.find((item: any) => item.id === "summary.current");
    expect(currentRecipe).toMatchObject({ requiredCapability: "read", mutates: false });
    const currentRun = await runCli(home, currentRecipe.argvTemplate.slice(1));
    const currentPage = JSON.parse(currentRun.stdout);
    expect(currentPage.items.map((item: any) => item.id)).toEqual([corrected.id]);
    expect(currentPage.selection).toEqual({
      mode: "current_only",
      excludes: ["stale", "superseded"],
      emptyDoesNotProveNoHistory: true,
      historyRecipeId: "summary.list",
    });
    const historyRun = await executeRecipe("summary.list", {
      "{commitmentId}": commitment.id,
    });
    expect(historyRun.exitCode).toBe(0);
    expect(JSON.parse(historyRun.stdout).items.map((item: any) => item.id)).toEqual([
      compact.id, corrected.id,
    ]);

    const inspected = JSON.parse((await runOk(home, [
      "inspect", commitment.id, "--tenant", "robotics/team-a", "--actor", "cold-agent", "--json",
    ])).stdout);
    expect(inspected.claims).toHaveLength(1);
    expect(inspected.claims[0]).toMatchObject({ releaseReason: "task_done" });
    expect(inspected.claims[0].releasedAt).not.toBeNull();
    expect(inspected.events.some((item: any) => item.eventType === "commitment_summary_appended"))
      .toBe(true);

    await runOk(home, [
      "reopen", commitment.id, "--tenant", "robotics/team-a", "--actor", "cold-agent", "--json",
    ]);
    const staleCurrent = JSON.parse((await runCli(home, currentRecipe.argvTemplate.slice(1))).stdout);
    expect(staleCurrent.items).toEqual([]);
    expect(staleCurrent.selection.emptyDoesNotProveNoHistory).toBe(true);
    expect(JSON.parse((await executeRecipe("summary.list", {
      "{commitmentId}": commitment.id,
    })).stdout).items).toHaveLength(2);
  });

  it("filters recipe guidance without pretending that local aliases are access control", async () => {
    const home = await freshHome();
    const result = await runOk(home, [
      "onboard", "--space", "readers", "--actor", "reader", "--capabilities", "read", "--json",
    ]);
    const response = JSON.parse(result.stdout) as Record<string, any>;
    expect(response.recipeCapabilities).toEqual(["read"]);
    expect(response.recipes.every((recipe: any) => recipe.requiredCapability === "read")).toBe(true);
    expect(response.recipes.every((recipe: any) => recipe.mutates === false)).toBe(true);
    expect(response.authority.capabilityEnforcement).toBe("none");
    expect(response.guide.journeys.map((journey: any) => journey.id)).toEqual(["inspect-first"]);
  });

  it("keeps even the historical default space free of bundled domain vocabulary", async () => {
    const home = await freshHome();
    const response = JSON.parse((await runOk(home, [
      "onboard", "--space", "gwendall", "--actor", "cold", "--json",
    ])).stdout) as Record<string, any>;
    expect(response.discovery.extensions).toEqual([]);
    const serialized = JSON.stringify(response).toLowerCase();
    for (const forbidden of ["gmail", "github", "mercury", "_life"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("ordinary commands cannot contaminate a later cold onboarding with provider vocabulary", async () => {
    const home = await freshHome();
    await runOk(home, ["onboard", "--space", "shared", "--actor", "holder", "--json"]);
    await runOk(home, [
      "resource", "list", "--tenant", "shared", "--actor", "holder", "--json",
    ]);
    await runOk(home, [
      "add", "Generic work", "--tenant", "shared", "--actor", "holder", "--json",
    ]);

    const cold = JSON.parse((await runOk(home, [
      "onboard", "--space", "shared", "--actor", "cold-peer", "--json",
    ])).stdout) as Record<string, any>;
    expect(cold.disposition).toBe("joined");
    expect(cold.discovery.extensions).toEqual([]);
    const serialized = JSON.stringify(cold).toLowerCase();
    for (const forbidden of ["gmail", "github", "mercury", "_life"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("returns versioned JSON problems for missing identity, unsafe spaces and bad capability requests", async () => {
    const home = await freshHome();
    for (const args of [
      ["onboard", "--space", "safe", "--json"],
      ["onboard", "--space", "unsafe space", "--actor", "a", "--json"],
      ["onboard", "--space", "safe", "--actor", "a", "--capabilities", "effect", "--json"],
      ["onboard", "--space", "safe", "--actor", "a", "--capabilities", "propose", "--json"],
      ["onboard", "--space", "safe", "--actor", "a", "--capabilities", "coordinate", "--json"],
      ["onboard", "--space", "safe", "--actor", "a", "--unknown", "x", "--json"],
      ["onboard", "--space", "safe", "--actor", "a", "--json=maybe"],
      ["onboard", "--space", "safe", "--tenant", "other", "--actor", "a", "--json"],
    ]) {
      const result = await runCli(home, args);
      expect(result.exitCode).toBe(2);
      const problem = JSON.parse(result.stdout);
      expect(problem).toMatchObject({
        contractVersion: "tasq.autonomous-bootstrap-problem.v1",
        status: "error",
        code: "invalid_input",
        retryable: false,
      });
      expect(problem.nextActions[0].argv.slice(1)).toEqual(["onboard", "--help"]);
    }
    expect(existsSync(join(home, ".tasq"))).toBe(false);
  });

  it("converges cold competing CLI processes on one durable creator", async () => {
    const home = await freshHome();
    const [alpha, beta] = await Promise.all([
      runCli(home, ["onboard", "--space", "race", "--actor", "alpha", "--json"]),
      runCli(home, ["onboard", "--space", "race", "--actor", "beta", "--json"]),
    ]);
    expect([alpha.exitCode, beta.exitCode]).toEqual([0, 0]);
    const responses = [JSON.parse(alpha.stdout), JSON.parse(beta.stdout)];
    // A process that inserted the space can lose a later read to SQLITE_BUSY;
    // onboard is safely replayed and that final attempt honestly reports
    // `joined`. Therefore the response set may be created+joined or
    // joined+joined, while durable creator identity remains singular.
    expect(responses.every((response) => ["created", "joined"].includes(response.disposition)))
      .toBe(true);
    expect(responses.filter((response) => response.disposition === "created").length)
      .toBeLessThanOrEqual(1);
    expect(responses[0].space).toEqual(responses[1].space);
    expect(responses[0].space.createdByPrincipalId).toBe(responses[1].space.createdByPrincipalId);
    expect(responses.map((response) => response.actor.principalId))
      .toContain(responses[0].space.createdByPrincipalId);
  });

  it("never auto-detects a life projection from HOME", async () => {
    const home = await freshHome();
    mkdirSync(join(home, "Code", "_life"), { recursive: true });
    writeFileSync(join(home, "Code", "_life", "TASKS.md"), "user-owned\n");
    const initialized = JSON.parse((await runOk(home, ["init", "--json"])).stdout);
    expect(initialized.projectionTarget).toBeNull();
    expect(readFileSync(join(home, "Code", "_life", "TASKS.md"), "utf8")).toBe("user-owned\n");
  });
});

describe("bounded universal context", () => {
  it("emits the exact canonical payload it budgets and exposes explicit omissions", async () => {
    const home = await freshHome();
    await runOk(home, ["onboard", "--space", "context-e2e", "--actor", "reader", "--json"]);
    await runOk(home, ["add", "First", "--tenant", "context-e2e", "--actor", "reader", "--json"]);
    await runOk(home, ["add", "Second", "--tenant", "context-e2e", "--actor", "reader", "--json"]);
    const result = await runOk(home, [
      "context", "--max-records", "1", "--max-tokens", "2048",
      "--tenant", "context-e2e", "--actor", "reader", "--json",
    ]);
    const packet = JSON.parse(result.stdout);
    expect(packet).toMatchObject({
      contractVersion: "tasq.context-packet.v1",
      selection: {
        eligibleRecords: 2,
        selectedRecords: 1,
        omitted: { recordBudget: 1, tokenBudget: 0, candidateScanLimit: 0 },
      },
      budget: { maxRecords: 1, maxTokens: 2048, hardLimitSatisfied: true },
    });
    expect(Buffer.byteLength(result.stdout.trimEnd(), "utf8")).toBe(packet.budget.measuredUtf8Bytes);
    expect(result.stdout).not.toContain("\n  \"");
    expect(packet.items[0]).not.toHaveProperty("nextAction");
  });

  it("fails closed on an invalid portable token budget", async () => {
    const home = await freshHome();
    const result = await runCli(home, ["context", "--max-tokens", "100", "--json"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("greater than or equal to 1024");
  });
});

describe("external context links", () => {
  it("executes cold onboarding recipes while keeping reusable memory outside Tasq", async () => {
    const home = await freshHome();
    const onboarding = JSON.parse((await runOk(home, [
      "onboard", "--space", "robotics", "--actor", "cold-agent", "--json",
    ])).stdout) as Record<string, any>;
    const commitment = JSON.parse((await runOk(home, [
      "add", "Calibrate left arm", "--tenant", "robotics", "--actor", "cold-agent", "--json",
    ])).stdout) as Record<string, any>;
    const attach = onboarding.recipes.find((item: any) => item.id === "context-link.attach");
    expect(attach).toBeDefined();
    const values: Record<string, string> = {
      "{commitmentId}": commitment.id,
      "{systemUri}": "https://memory.example.test",
      "{resourceType}": "runbook",
      "{externalId}": "robotics/calibration/left-arm",
      "{version}": "v7",
      "{idempotencyKey}": "cold-link-1",
    };
    const attached = JSON.parse((await runCli(home,
      attach.argvTemplate.map((part: string) => values[part] ?? part).slice(1))).stdout);
    expect(attached).toMatchObject({
      contractVersion: "tasq.external-context-link.v1",
      commitmentId: commitment.id,
      binding: "pinned",
      state: "active",
    });
    expect(attached).not.toHaveProperty("content");

    const current = JSON.parse((await runOk(home, [
      "context-link", "list", commitment.id,
      "--tenant", "robotics", "--actor", "cold-agent", "--json",
    ])).stdout);
    expect(current).toMatchObject({
      contractVersion: "tasq.external-context-link-page.v1",
      selection: { emptyDoesNotProveNoHistory: true },
    });
    expect(current.items.map((item: any) => item.id)).toEqual([attached.id]);

    await runOk(home, [
      "context-link", "detach", attached.id, "--idempotency-key", "cold-detach-1",
      "--tenant", "robotics", "--actor", "cold-agent", "--json",
    ]);
    const empty = JSON.parse((await runOk(home, [
      "context-link", "list", commitment.id,
      "--tenant", "robotics", "--actor", "cold-agent", "--json",
    ])).stdout);
    expect(empty.items).toEqual([]);
    const history = JSON.parse((await runOk(home, [
      "context-link", "list", commitment.id, "--history",
      "--tenant", "robotics", "--actor", "cold-agent", "--json",
    ])).stdout);
    expect(history.items.map((item: any) => item.state)).toEqual(["superseded", "detached"]);

    const inspection = JSON.parse((await runOk(home, [
      "inspect", commitment.id, "--tenant", "robotics", "--actor", "cold-agent", "--json",
    ])).stdout);
    expect(inspection.externalContextLinks).toHaveLength(2);
  });
});

describe("generic resource coordination", () => {
  it("executes the onboarding recipe from scratch and verifies exact fence authority", async () => {
    const home = await freshHome();
    const onboarding = JSON.parse((await runOk(home, [
      "onboard", "--space", "robotics/team-a", "--actor", "alpha", "--json",
    ])).stdout) as Record<string, any>;
    const recipe = onboarding.recipes.find((item: any) => item.id === "resource.acquire");
    expect(recipe).toBeDefined();
    const replacements: Record<string, string> = {
      "{resourceKey}": "robotics/arm:left/toolhead",
      "{duration}": "30m",
      "{idempotencyKey}": "alpha-arm-1",
    };
    const argv = recipe.argvTemplate.map((part: string) => replacements[part] ?? part);
    const acquiredRun = await runCli(home, argv.slice(1));
    expect(acquiredRun).toMatchObject({ exitCode: 0, stderr: "" });
    const acquired = JSON.parse(acquiredRun.stdout);
    expect(acquired).toMatchObject({
      contractVersion: "tasq.resource-operation.v1",
      disposition: "acquired",
      lease: { workspaceId: "robotics/team-a", resourceKey: "robotics/arm:left/toolhead", holderActor: "alpha", fence: 1, revision: 1 },
    });

    const verified = await runCli(home, [
      "resource", "verify", acquired.lease.resourceKey,
      "--lease", acquired.lease.id,
      "--fence", String(acquired.lease.fence),
      "--tenant", "robotics/team-a",
      "--actor", "alpha",
      "--json",
    ]);
    expect(verified).toMatchObject({ exitCode: 0, stderr: "" });
    expect(JSON.parse(verified.stdout)).toMatchObject({
      contractVersion: "tasq.resource-fence.v1",
      status: "valid",
      leaseId: acquired.lease.id,
      fence: 1,
    });
  });

  it("elects one winner across processes and gives the loser actionable typed contention", async () => {
    const home = await freshHome();
    await runOk(home, ["onboard", "--space", "race", "--actor", "alpha", "--json"]);
    await runOk(home, ["onboard", "--space", "race", "--actor", "beta", "--json"]);
    const scope = ["--tenant", "race", "--json"];
    const [alpha, beta] = await Promise.all([
      runCli(home, ["resource", "acquire", "robot:arm", "--actor", "alpha", "--idempotency-key", "alpha-1", ...scope]),
      runCli(home, ["resource", "acquire", "robot:arm", "--actor", "beta", "--idempotency-key", "beta-1", ...scope]),
    ]);
    expect([alpha.exitCode, beta.exitCode].sort()).toEqual([0, 1]);
    const loser = alpha.exitCode === 1 ? alpha : beta;
    expect(loser.stderr).toBe("");
    const problem = JSON.parse(loser.stdout);
    expect(problem).toMatchObject({
      contractVersion: "tasq.resource-problem.v1",
      status: "error",
      code: "contended",
      retryable: true,
      currentLease: { status: "active", lease: { resourceKey: "robot:arm", fence: 1 } },
    });
    expect(problem.nextActions.map((action: any) => action.kind)).toEqual([
      "inspect", "wait_until", "retry", "choose_alternative",
    ]);
    expect(problem.nextActions[1].notBefore).toBe(problem.currentLease.lease.expiresAt);
  });

  it("releases and reacquires with a higher fence; stale verification is structured JSON", async () => {
    const home = await freshHome();
    await runOk(home, ["onboard", "--space", "lab", "--actor", "alpha", "--json"]);
    const first = JSON.parse((await runOk(home, [
      "resource", "acquire", "camera:front", "--idempotency-key", "a1",
      "--tenant", "lab", "--actor", "alpha", "--json",
    ])).stdout);
    await runOk(home, [
      "resource", "release", "camera:front",
      "--lease", first.lease.id, "--fence", String(first.lease.fence),
      "--revision", String(first.lease.revision), "--idempotency-key", "r1",
      "--tenant", "lab", "--actor", "alpha", "--json",
    ]);
    const second = JSON.parse((await runOk(home, [
      "resource", "acquire", "camera:front", "--idempotency-key", "a2",
      "--tenant", "lab", "--actor", "alpha", "--json",
    ])).stdout);
    expect(second.lease.fence).toBe(2);
    const stale = await runCli(home, [
      "resource", "verify", "camera:front",
      "--lease", first.lease.id, "--fence", String(first.lease.fence),
      "--tenant", "lab", "--actor", "alpha", "--json",
    ]);
    expect(stale).toMatchObject({ exitCode: 1, stderr: "" });
    expect(JSON.parse(stale.stdout)).toMatchObject({
      contractVersion: "tasq.resource-problem.v1",
      code: "stale_fence",
      currentLease: { status: "active", lease: { id: second.lease.id, fence: 2 } },
    });
    const world = JSON.parse((await runOk(home, [
      "resource", "list", "--tenant", "lab", "--actor", "alpha", "--json",
    ])).stdout);
    expect(world).toMatchObject({ contractVersion: "tasq.resource-world.v1", workspaceId: "lab" });
    expect(world.leases).toHaveLength(1);
  });

  it("rejects hidden scope and identity before opening a store", async () => {
    const home = await freshHome();
    for (const command of [
      ["resource", "list", "--actor", "alpha", "--json"],
      ["resource", "list", "--tenant", "lab", "--json"],
      ["resource", "list", "--tenant", "lab", "--actor", "alpha", "--unknown", "x", "--json"],
      ["resource", "list", "--tenant", "lab", "--actor", "alpha", "--json=maybe"],
    ]) {
      const result = await runCli(home, command);
      expect(result).toMatchObject({ exitCode: 2, stderr: "" });
      expect(JSON.parse(result.stdout)).toMatchObject({
        contractVersion: "tasq.resource-problem.v1",
        status: "error",
        code: "invalid_input",
      });
    }
    expect(existsSync(join(home, ".tasq"))).toBe(false);
  });
});

describe("canonical commitment inspection", () => {
  it("exposes an additive profile-neutral JSON graph and human projection", async () => {
    const home = await freshHome();
    await runOk(home, ["init"]);
    const added = await runOk(home, ["add", "Inspect me", "--json"]);
    const task = JSON.parse(added.stdout) as Record<string, unknown>;
    const jsonResult = await runOk(home, ["inspect", String(task.id), "--json"]);
    const snapshot = JSON.parse(jsonResult.stdout) as Record<string, unknown>;
    expectExactKeys(snapshot, [
      "contractVersion", "inspectedAt", "workspaceId", "commitment", "principals",
      "assignments", "relations", "claims", "attempts", "artifacts", "effects",
      "effectApprovals", "effectReceipts", "evidence",
      "completionRecords", "conditions", "observations", "reconciliations",
      "externalRefs", "externalContextLinks", "events", "resumeCursor",
    ]);
    expect(snapshot.contractVersion).toBe("tasq.inspect.v1");
    expect(snapshot).not.toHaveProperty("tenantId");
    expect(snapshot.commitment).toMatchObject({ id: task.id, workspaceId: "gwendall" });
    expect(snapshot.commitment).not.toHaveProperty("areaId");
    expect(snapshot.commitment).not.toHaveProperty("nextAction");
    expect(snapshot.resumeCursor).toMatchObject({ afterEventSequence: expect.any(Number) });

    const human = await runOk(home, ["inspect", String(task.id)]);
    expect(human.stdout).toContain("# Inspect me");
    expect(human.stdout).toContain("## Resume cursor");
  });
});

describe("machine discovery and onboarding", () => {
  it("cold-starts from the CLI without repository or domain knowledge", async () => {
    const home = await freshHome();
    await runOk(home, ["init"]);
    const discovered = JSON.parse((await runOk(home, ["discover", "--json"])).stdout) as Record<string, any>;
    expectExactKeys(discovered, [
      "contractVersion", "generatedAt", "expiresAt", "workspaceId", "transportBoundary",
      "protocol", "capabilities", "extensions", "cursors", "resources", "limits",
      "compatibilityDigest",
    ]);
    expect(discovered).toMatchObject({
      contractVersion: "tasq.discovery.v1",
      workspaceId: "gwendall",
      transportBoundary: "local_process",
      protocol: { versions: [1] },
    });
    expect(discovered.extensions).toEqual([]);

    const clientHello = {
      contractVersion: "tasq.client-hello.v1",
      supportedProtocolVersions: [1],
      requiredCapabilities: [{
        uri: "https://schemas.tasq.dev/capabilities/commitments",
        version: 1,
      }],
      requiredTypes: [],
      requiredCursors: [{
        uri: "https://schemas.tasq.dev/cursors/event-sequence",
        version: 1,
      }],
      knownCompatibilityDigest: discovered.compatibilityDigest,
    };
    const negotiated = JSON.parse((await runOk(home, [
      "discover", "negotiate", "--hello", JSON.stringify(clientHello), "--json",
    ])).stdout);
    expect(negotiated).toMatchObject({
      contractVersion: "tasq.onboarding.v1",
      status: "compatible",
      selectedProtocolVersion: 1,
      problems: [],
    });

    const stale = await runCli(home, [
      "discover", "negotiate", "--hello", JSON.stringify({
        ...clientHello,
        knownCompatibilityDigest: "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      }), "--json",
    ]);
    expect(stale.exitCode).toBe(1);
    expect(JSON.parse(stale.stdout)).toMatchObject({
      status: "refresh_required",
      problems: [{ code: "discovery_changed" }],
    });
  });
});

describe("agentic commitment primitives", () => {
  it("coordinates claim → attempt → evidence-backed completion", async () => {
    const home = await freshHome();
    await runOk(home, ["init"]);
    const created = JSON.parse(
      (await runOk(home, [
        "add",
        "Publish verified release",
        "--next",
        "Run deployment",
        "--success",
        "Public endpoint returns 200",
        "--completion",
        "evidence",
        "--json",
      ])).stdout,
    );
    expectExactKeys(created, TASK_V1_KEYS);

    const initialClaim = JSON.parse(
      (await runOk(home, ["claim", created.id.slice(0, 12), "--actor", "agent-a", "--for", "10m", "--json"])).stdout,
    );
    expectExactKeys(initialClaim, CLAIM_V1_KEYS);
    const released = JSON.parse(
      (await runOk(home, [
        "release", created.id.slice(0, 12), "--actor", "agent-a",
        "--reason", "contract test", "--json",
      ])).stdout,
    );
    expectExactKeys(released, CLAIM_V1_KEYS);
    expect(released.releasedAt).not.toBeNull();
    expect(released.releaseReason).toBe("contract test");

    const claim = JSON.parse(
      (await runOk(home, ["claim", created.id.slice(0, 12), "--actor", "agent-a", "--for", "10m", "--json"])).stdout,
    );
    expectExactKeys(claim, CLAIM_V1_KEYS);
    expect(claim.fence).toBe(initialClaim.fence + 1);
    expect(claim.actor).toBe("agent-a");

    const hidden = JSON.parse(
      (await runOk(home, ["next", "--actor", "agent-b", "--json"])).stdout,
    );
    expect(hidden).toEqual([]);

    const attempt = JSON.parse(
      (await runOk(home, [
        "attempt",
        "start",
        created.id.slice(0, 12),
        "--actor",
        "agent-a",
        "--runtime",
        "a2a",
        "--external-id",
        "remote-42",
        "--json",
      ])).stdout,
    );
    expectExactKeys(attempt, ATTEMPT_V1_KEYS);
    expect(attempt.claimId).toBe(claim.id);
    expect(attempt.status).toBe("running");

    const premature = await runCli(home, ["done", created.id.slice(0, 12), "--actor", "agent-a"]);
    expect(premature.exitCode).not.toBe(0);
    expect(premature.stderr).toContain("requires explicit evidence");

    const succeeded = JSON.parse((await runOk(home, [
      "attempt", "succeed", attempt.id.slice(0, 12), "--actor", "agent-a",
      "--message", "deployment command returned success", "--json",
    ])).stdout);
    expectExactKeys(succeeded, ATTEMPT_V1_KEYS);
    expect(succeeded.status).toBe("succeeded");
    expect(succeeded.endedAt).not.toBeNull();
    const evidence = JSON.parse(
      (await runOk(home, [
        "evidence",
        "add",
        created.id.slice(0, 12),
        "--actor",
        "watcher:http",
        "--kind",
        "deployment",
        "--summary",
        "endpoint returned 200",
        "--uri",
        "https://example.test/release",
        "--attempt",
        attempt.id.slice(0, 12),
        "--json",
      ])).stdout,
    );
    expectExactKeys(evidence, EVIDENCE_V1_KEYS);

    const attemptList = JSON.parse(
      (await runOk(home, ["attempt", "list", created.id.slice(0, 12), "--json"])).stdout,
    );
    expect(attemptList).toHaveLength(1);
    expectExactKeys(attemptList[0], ATTEMPT_V1_KEYS);
    const attemptShown = JSON.parse(
      (await runOk(home, ["attempt", "show", attempt.id.slice(0, 12), "--json"])).stdout,
    );
    expectExactKeys(attemptShown, ATTEMPT_V1_KEYS);

    const evidenceList = JSON.parse(
      (await runOk(home, ["evidence", "list", created.id.slice(0, 12), "--json"])).stdout,
    );
    expect(evidenceList).toHaveLength(1);
    expectExactKeys(evidenceList[0], EVIDENCE_V1_KEYS);
    const evidenceShown = JSON.parse(
      (await runOk(home, ["evidence", "show", evidence.id.slice(0, 12), "--json"])).stdout,
    );
    expectExactKeys(evidenceShown, EVIDENCE_V1_KEYS);

    const completed = JSON.parse(
      (await runOk(home, [
        "done",
        created.id.slice(0, 12),
        "--actor",
        "agent-a",
        "--evidence",
        evidence.id.slice(0, 12),
        "--json",
      ])).stdout,
    );
    expectExactKeys(completed, TASK_V1_KEYS);
    expect(completed.status).toBe("done");
    expect(completed.completedAt).not.toBeNull();

    const shown = JSON.parse(
      (await runOk(home, ["show", created.id.slice(0, 12), "--json"])).stdout,
    );
    expectExactKeys(shown, [
      ...TASK_V1_KEYS,
      "dependencies",
      "unresolvedBlockers",
      "claim",
      "attempts",
      "evidence",
    ]);
    expect(shown.claim).toBeNull();
    expect(shown.attempts).toHaveLength(1);
    expect(shown.evidence).toHaveLength(1);
  });
});

describe("wait / observe / reconcile CLI", () => {
  it("runs the typed fact loop and exactly-once deadline fallback through stable JSON", async () => {
    const home = await freshHome();
    await runOk(home, ["init"]);
    const source = JSON.parse((await runOk(home, ["add", "Await Alice", "--json"])).stdout);
    const base = Date.now();
    const parameters = JSON.stringify({
      connectorAccount: "gmail:primary",
      threadId: "thread-cli",
      sender: "alice@example.test",
    });
    const condition = JSON.parse((await runOk(home, [
      "wait", "create", source.id.slice(0, 12),
      "--kind", "gmail.thread_reply",
      "--parameters", parameters,
      "--deadline", String(base + 600_000),
      "--idempotency-key", "cli-wait-1",
      "--actor", "agent:planner",
      "--json",
    ])).stdout);
    expectExactKeys(condition, WAIT_CONDITION_V1_KEYS);
    expect(condition).toMatchObject({
      taskId: source.id,
      status: "waiting",
      kind: "gmail.thread_reply",
      fallbackKind: "none",
    });

    const waitRetry = JSON.parse((await runOk(home, [
      "wait", "create", source.id.slice(0, 12),
      "--kind", "gmail.thread_reply",
      "--parameters", parameters,
      "--deadline", String(base + 600_000),
      "--idempotency-key", "cli-wait-1",
      "--actor", "agent:planner",
      "--json",
    ])).stdout);
    expect(waitRetry.id).toBe(condition.id);

    const observationPayload = JSON.stringify({
      connectorAccount: "gmail:primary",
      messageId: "message-cli",
      threadId: "thread-cli",
      sender: "alice@example.test",
    });
    const observation = JSON.parse((await runOk(home, [
      "observation", "ingest",
      "--source", "gmail:primary",
      "--external-event-id", "delivery-cli-1",
      "--kind", "gmail.message",
      "--payload", observationPayload,
      // Anchor the domain occurrence clock to the durable condition clock, not
      // the parent test process. Under full-suite CPU contention, CLI startup
      // can legitimately take >1s and make `base + 1_000` predate notBefore.
      "--occurred-at", String(condition.notBefore + 1_000),
      "--verification-level", "authenticated_source",
      "--verification-method", "oauth:webhook",
      "--actor", "watcher:gmail",
      "--json",
    ])).stdout);
    expectExactKeys(observation, OBSERVATION_V1_KEYS);
    expect(observation).toMatchObject({
      source: "gmail:primary",
      externalEventId: "delivery-cli-1",
      recordedBy: "watcher:gmail",
      verificationLevel: "authenticated_source",
    });

    const candidates = JSON.parse((await runOk(home, [
      "wait", "candidates", condition.id.slice(0, 12), "--json",
    ])).stdout);
    expect(candidates.map((item: { id: string }) => item.id)).toEqual([observation.id]);
    const reconciled = JSON.parse((await runOk(home, [
      "reconcile", condition.id.slice(0, 12), observation.id.slice(0, 12),
      "--actor", "agent:reconciler", "--json",
    ])).stdout);
    expectExactKeys(reconciled, RECONCILIATION_V1_KEYS);
    expect(reconciled).toMatchObject({
      decision: "matched",
      effect: "satisfied",
      reconciledBy: "agent:reconciler",
    });
    expect(reconciled.evidenceId).not.toBeNull();
    const reconcileRetry = JSON.parse((await runOk(home, [
      "reconcile", condition.id.slice(0, 12), observation.id.slice(0, 12), "--json",
    ])).stdout);
    expect(reconcileRetry.id).toBe(reconciled.id);

    const shown = JSON.parse((await runOk(home, [
      "wait", "show", condition.id.slice(0, 12), "--json",
    ])).stdout);
    expectExactKeys(shown, WAIT_CONDITION_V1_KEYS);
    expect(shown).toMatchObject({ status: "satisfied", satisfiedByObservationId: observation.id });
    const observations = JSON.parse((await runOk(home, [
      "observation", "list", "--kind", "gmail.message", "--json",
    ])).stdout);
    expect(observations).toHaveLength(1);
    expectExactKeys(observations[0], OBSERVATION_V1_KEYS);
    const reconciliations = JSON.parse((await runOk(home, [
      "reconcile", "list", condition.id.slice(0, 12), "--json",
    ])).stdout);
    expect(reconciliations).toHaveLength(1);
    expectExactKeys(reconciliations[0], RECONCILIATION_V1_KEYS);

    const cancelledWait = JSON.parse((await runOk(home, [
      "wait", "create", source.id.slice(0, 12),
      "--kind", "http.response",
      "--parameters", JSON.stringify({
        url: "https://example.test/health",
        method: "GET",
        allowedStatuses: [200],
      }),
      "--json",
    ])).stdout);
    const cancelled = JSON.parse((await runOk(home, [
      "wait", "cancel", cancelledWait.id.slice(0, 12),
      "--reason", "No longer needed", "--json",
    ])).stdout);
    expectExactKeys(cancelled, WAIT_CONDITION_V1_KEYS);
    expect(cancelled).toMatchObject({ status: "cancelled", cancelReason: "No longer needed" });

    const deadlineSource = JSON.parse((await runOk(home, ["add", "Escalate if silent", "--json"])).stdout);
    const fallbackBase = Date.now();
    const due = JSON.parse((await runOk(home, [
      "wait", "create", deadlineSource.id.slice(0, 12),
      "--kind", "gmail.thread_reply",
      "--parameters", JSON.stringify({
        connectorAccount: "gmail:primary",
        threadId: "never-replies",
      }),
      "--deadline", String(fallbackBase + 600_000),
      "--fallback-kind", "create_task",
      "--fallback-spec", JSON.stringify({
        title: "Call Alice",
        nextAction: "Call Alice about the unanswered thread",
        priority: 1,
      }),
      "--json",
    ])).stdout);
    const sweep = JSON.parse((await runOk(home, [
      "wait", "sweep", "--at", String(fallbackBase + 601_000), "--json",
    ])).stdout);
    expectExactKeys(sweep, [
      "sweepNow", "evaluated", "satisfied", "expired", "alreadyTerminal", "results", "errors",
    ]);
    expect(sweep).toMatchObject({ evaluated: 1, satisfied: 0, expired: 1, errors: [] });
    expectExactKeys(sweep.results[0], [
      "condition", "outcome", "sweepNow", "reconciliations", "fallbackResultTaskId",
    ]);
    expect(sweep.results[0]).toMatchObject({ outcome: "expired" });
    expect(sweep.results[0].condition).toMatchObject({ id: due.id, status: "expired" });
    expect(sweep.results[0].fallbackResultTaskId).not.toBeNull();
    const fallback = JSON.parse((await runOk(home, [
      "show", sweep.results[0].fallbackResultTaskId.slice(0, 12), "--json",
    ])).stdout);
    expect(fallback).toMatchObject({ title: "Call Alice", priority: 1, status: "open" });

    const retrySweep = JSON.parse((await runOk(home, [
      "wait", "sweep", "--at", String(fallbackBase + 602_000), "--json",
    ])).stdout);
    expect(retrySweep).toMatchObject({ evaluated: 0, expired: 0, results: [], errors: [] });
    const tasks = JSON.parse((await runOk(home, ["list", "--include-scheduled", "--json"])).stdout);
    expect(tasks.filter((task: { title: string }) => task.title === "Call Alice")).toHaveLength(1);
  });

  it("prints dedicated help and rejects malformed typed input", async () => {
    const home = await freshHome();
    await runOk(home, ["init"]);
    for (const command of ["wait", "observation", "reconcile"]) {
      const help = await runOk(home, [command, "--help"]);
      expect(help.stdout).toContain(command);
    }
    const malformed = await runCli(home, [
      "observation", "ingest",
      "--source", "x", "--external-event-id", "x", "--kind", "gmail.message",
      "--payload", "{bad", "--occurred-at", String(Date.now()),
    ]);
    expect(malformed.exitCode).toBe(2);
    expect(malformed.stderr).toContain("Invalid JSON for --payload");
    const invalidKind = await runCli(home, [
      "observation", "list", "--kind", "gmail.reply",
    ]);
    expect(invalidKind.exitCode).toBe(2);
    expect(invalidKind.stderr).toContain("Allowed: gmail.message");
  });
});

// ──────────────────────────────────────────────────────────────────────
// Init + config
// ──────────────────────────────────────────────────────────────────────

describe("init + config", () => {
  it("init creates DB + config file", async () => {
    const home = await freshHome();
    const r = await runOk(home, ["init", "--json"]);
    const out = JSON.parse(r.stdout);
    expect(out.ok).toBe(true);
    expect(existsSync(out.configPath)).toBe(true);
    expect(existsSync(out.dbPath)).toBe(true);
  });

  it("config show returns the loaded config", async () => {
    const home = await freshHome();
    await runOk(home, ["init"]);
    const r = await runOk(home, ["config", "show", "--json"]);
    const cfg = JSON.parse(r.stdout);
    expect(cfg.tenantId).toBe("gwendall");
    expect(cfg.defaultActor).toBe("gwendall");
  });

  it("config set persists value", async () => {
    const home = await freshHome();
    await runOk(home, ["init"]);
    await runOk(home, ["config", "set", "projectionTarget", "/tmp/proj.md"]);
    const r = await runOk(home, ["config", "show", "--json"]);
    const cfg = JSON.parse(r.stdout);
    expect(cfg.projectionTarget).toBe("/tmp/proj.md");
  });

  it("--tenant selects an isolated tenant instead of being ignored", async () => {
    const home = await freshHome();
    await runOk(home, ["init"]);
    await runOk(home, ["add", "tenant-only", "--tenant", "acme"]);
    const normal = JSON.parse((await runOk(home, ["list", "--json"])).stdout);
    const acme = JSON.parse((await runOk(home, ["list", "--tenant", "acme", "--json"])).stdout);
    expect(normal).toHaveLength(0);
    expect(acme.map((task: { title: string }) => task.title)).toEqual(["tenant-only"]);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Areas
// ──────────────────────────────────────────────────────────────────────

describe("areas", () => {
  it("area add then list", async () => {
    const home = await freshHome();
    await runOk(home, ["init"]);
    await runOk(home, ["area", "add", "Kami", "--slug", "kami", "--importance", "5"]);
    const r = await runOk(home, ["area", "list", "--json"]);
    const areas = JSON.parse(r.stdout);
    expect(areas).toHaveLength(1);
    expect(areas[0].slug).toBe("kami");
    expect(areas[0].importance).toBe(5);
  });

  it("area add rejects bad importance (validation, exit code 2)", async () => {
    const home = await freshHome();
    await runOk(home, ["init"]);
    const r = await runCli(home, [
      "area",
      "add",
      "X",
      "--slug",
      "x",
      "--importance",
      "10",
    ]);
    expect(r.exitCode).toBe(2);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Tasks — full lifecycle
// ──────────────────────────────────────────────────────────────────────

describe("tasks lifecycle", () => {
  it("--idempotency-key makes add safely replayable", async () => {
    const home = await freshHome();
    await runOk(home, ["init"]);
    const first = JSON.parse((await runOk(home, ["add", "once", "--idempotency-key", "req-1", "--json"])).stdout);
    const replay = JSON.parse((await runOk(home, ["add", "once", "--idempotency-key", "req-1", "--json"])).stdout);
    expect(replay.id).toBe(first.id);
    const tasks = JSON.parse((await runOk(home, ["list", "--json"])).stdout);
    expect(tasks).toHaveLength(1);
  });

  it("add → list → start → done", async () => {
    const home = await freshHome();
    await runOk(home, ["init"]);
    await runOk(home, ["area", "add", "Kami", "--slug", "kami", "--importance", "5"]);

    const add = await runOk(home, [
      "add",
      "Outline pitch",
      "--area",
      "kami",
      "--next",
      "Open Keynote",
      "--json",
    ]);
    const task = JSON.parse(add.stdout);
    expect(task.title).toBe("Outline pitch");
    expect(task.status).toBe("open");

    const list = await runOk(home, ["list", "--json"]);
    expect(JSON.parse(list.stdout).length).toBe(1);

    const started = await runOk(home, ["start", task.id, "--json"]);
    expect(JSON.parse(started.stdout).status).toBe("in_progress");

    const done = await runOk(home, ["done", task.id, "--note", "shipped", "--json"]);
    const doneTask = JSON.parse(done.stdout);
    expect(doneTask.status).toBe("done");
    expect(doneTask.completedAt).toBeGreaterThan(0);
  });

  it("short id resolution works", async () => {
    const home = await freshHome();
    await runOk(home, ["init"]);
    await runOk(home, ["area", "add", "K", "--slug", "k", "--importance", "3"]);
    const add = await runOk(home, ["add", "t", "--area", "k", "--json"]);
    const task = JSON.parse(add.stdout);
    const shortId = task.id.slice(0, 8);

    const done = await runOk(home, ["done", shortId, "--json"]);
    expect(JSON.parse(done.stdout).id).toBe(task.id);
  });

  it("ambiguous short id prefix surfaces full candidate ids", async () => {
    // Two tasks created back-to-back may share their UUIDv7 timestamp prefix
    // when they land in the same millisecond. We force the collision by
    // crafting a synthetic prefix that matches both ids.
    const home = await freshHome();
    await runOk(home, ["init"]);
    await runOk(home, ["area", "add", "K", "--slug", "k", "--importance", "3"]);
    const a = JSON.parse((await runOk(home, ["add", "alpha", "--area", "k", "--json"])).stdout);
    const b = JSON.parse((await runOk(home, ["add", "beta", "--area", "k", "--json"])).stdout);

    // Find the longest shared prefix between the two ids (will be at least the
    // UUIDv7 version+timestamp byte if they were created in the same ms,
    // otherwise we fall back to a single shared char).
    let shared = "";
    for (let i = 0; i < a.id.length && i < b.id.length; i++) {
      if (a.id[i] !== b.id[i]) break;
      shared += a.id[i];
    }
    // Ensure we have at least 4 chars (the helper's minimum) and the prefix is
    // ambiguous by construction.
    if (shared.length < 4) shared = a.id.slice(0, 4);
    const matches = [a.id, b.id].filter((id) => id.startsWith(shared));
    if (matches.length < 2) return; // skip if no real collision was produced

    const r = await runCli(home, ["done", shared]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain(`ambiguous task id prefix '${shared}'`);
    expect(r.stderr).toContain(a.id);
    expect(r.stderr).toContain(b.id);
    // The misleading second "task not found" message must NOT appear.
    expect(r.stderr).not.toContain(`task not found: ${shared}`);
  });

  it("status transitions emit events with correct actor + payload", async () => {
    const home = await freshHome();
    await runOk(home, ["init"]);
    await runOk(home, ["area", "add", "K", "--slug", "k", "--importance", "3"]);
    const add = await runOk(home, [
      "add",
      "t",
      "--area",
      "k",
      "--actor",
      "hermes",
      "--json",
    ]);
    const task = JSON.parse(add.stdout);

    await runOk(home, ["done", task.id, "--actor", "gwendall", "--note", "wired"]);

    const events = await runOk(home, [
      "event",
      "list",
      "--entity-id",
      task.id,
      "--json",
    ]);
    const log = JSON.parse(events.stdout);
    expect(log.length).toBeGreaterThanOrEqual(2);

    const created = log.find((e: any) => e.eventType === "created");
    const completed = log.find((e: any) => e.eventType === "completed");
    expect(created.actor).toBe("hermes");
    expect(completed.actor).toBe("gwendall");
    expect(completed.payload.note).toBe("wired");
  });

  it("invalid status transition exits 2", async () => {
    const home = await freshHome();
    await runOk(home, ["init"]);
    await runOk(home, ["area", "add", "K", "--slug", "k", "--importance", "3"]);
    const add = await runOk(home, ["add", "t", "--area", "k", "--json"]);
    const task = JSON.parse(add.stdout);
    await runOk(home, ["done", task.id]); // open → done OK
    const r = await runCli(home, ["block", task.id]); // done → blocked rejected
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("Invalid task status transition");
  });
});

// ──────────────────────────────────────────────────────────────────────
// Dependencies — depend / undepend, show surfacing, cycle guard, just-unblocked
// ──────────────────────────────────────────────────────────────────────

describe("dependencies", () => {
  async function twoTasks(home: string) {
    await runOk(home, ["init"]);
    await runOk(home, ["area", "add", "K", "--slug", "k", "--importance", "3"]);
    const a = JSON.parse((await runOk(home, ["add", "Task A", "--area", "k", "--json"])).stdout);
    const b = JSON.parse((await runOk(home, ["add", "Task B", "--area", "k", "--json"])).stdout);
    return { a, b };
  }

  it("depend --on succeeds and show lists the blocker", async () => {
    const home = await freshHome();
    const { a, b } = await twoTasks(home);

    const dep = await runOk(home, ["depend", a.id, "--on", b.id, "--json"]);
    const edge = JSON.parse(dep.stdout);
    expect(edge.fromTaskId).toBe(a.id);
    expect(edge.toTaskId).toBe(b.id);
    expect(edge.type).toBe("blocks");

    const show = await runOk(home, ["show", a.id]);
    expect(show.stdout).toContain("Blocked by:");
    expect(show.stdout).toContain("Task B");
  });

  it("show --json attaches dependencies + unresolvedBlockers", async () => {
    const home = await freshHome();
    const { a, b } = await twoTasks(home);
    await runOk(home, ["depend", a.id, "--on", b.id]);

    const show = await runOk(home, ["show", a.id, "--json"]);
    const obj = JSON.parse(show.stdout);
    expect(obj.id).toBe(a.id);
    expect(Array.isArray(obj.dependencies)).toBe(true);
    expect(obj.dependencies.length).toBe(1);
    expect(obj.unresolvedBlockers).toBe(1);
  });

  it("list tags the blocked dependent with a 🔒 marker", async () => {
    const home = await freshHome();
    const { a, b } = await twoTasks(home);
    await runOk(home, ["depend", a.id, "--on", b.id]);

    const list = await runOk(home, ["list"]);
    expect(list.stdout).toContain("🔒1");
  });

  it("cycle: depend A --on B then depend B --on A exits non-zero with a cycle error", async () => {
    const home = await freshHome();
    const { a, b } = await twoTasks(home);
    await runOk(home, ["depend", a.id, "--on", b.id]);

    const r = await runCli(home, ["depend", b.id, "--on", a.id]);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toLowerCase()).toContain("cycle");
  });

  it("undepend removes the edge and show no longer lists it", async () => {
    const home = await freshHome();
    const { a, b } = await twoTasks(home);
    await runOk(home, ["depend", a.id, "--on", b.id]);
    await runOk(home, ["undepend", a.id, "--on", b.id]);

    const show = await runOk(home, ["show", a.id, "--json"]);
    expect(JSON.parse(show.stdout).dependencies.length).toBe(0);
    const showText = await runOk(home, ["show", a.id]);
    expect(showText.stdout).not.toContain("Blocked by:");
  });

  it("completing the blocker tags the dependent as just unblocked in list", async () => {
    const home = await freshHome();
    const { a, b } = await twoTasks(home);
    await runOk(home, ["depend", a.id, "--on", b.id]);
    await runOk(home, ["done", b.id]);

    const list = await runOk(home, ["list"]);
    // The dependent (A) line should carry the just-unblocked tag; B is done.
    const lines = list.stdout.split("\n").filter((l) => l.includes("Task A"));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.some((l) => l.includes("just unblocked"))).toBe(true);
    // And it must no longer carry the lock marker.
    expect(lines.some((l) => l.includes("🔒"))).toBe(false);
  });

  it("--type relates_to is shown under Related", async () => {
    const home = await freshHome();
    const { a, b } = await twoTasks(home);
    await runOk(home, ["depend", a.id, "--on", b.id, "--type", "relates_to"]);

    const show = await runOk(home, ["show", a.id]);
    expect(show.stdout).toContain("Related:");
    expect(show.stdout).not.toContain("Blocked by:");
    // relates_to does not down-weight.
    const showJson = JSON.parse((await runOk(home, ["show", a.id, "--json"])).stdout);
    expect(showJson.unresolvedBlockers).toBe(0);
  });

  it("invalid --type exits non-zero", async () => {
    const home = await freshHome();
    const { a, b } = await twoTasks(home);
    const r = await runCli(home, ["depend", a.id, "--on", b.id, "--type", "requires"]);
    expect(r.exitCode).not.toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Goal + project — short-id resolution + transitions
// ──────────────────────────────────────────────────────────────────────

describe("goal + project commands", () => {
  it("goal update accepts a short-id prefix", async () => {
    const home = await freshHome();
    await runOk(home, ["init"]);
    await runOk(home, ["area", "add", "K", "--slug", "k", "--importance", "3"]);
    const add = await runOk(home, ["goal", "add", "Ship v1", "--area", "k", "--json"]);
    const goal = JSON.parse(add.stdout);
    const short = goal.id.slice(0, 12);

    const updated = await runOk(home, ["goal", "update", short, "--status", "paused", "--json"]);
    expect(JSON.parse(updated.stdout).status).toBe("paused");
  });

  it("project update + status accept a short-id prefix", async () => {
    const home = await freshHome();
    await runOk(home, ["init"]);
    await runOk(home, ["area", "add", "K", "--slug", "k", "--importance", "3"]);
    const add = await runOk(home, ["project", "add", "Pitch deck", "--area", "k", "--json"]);
    const project = JSON.parse(add.stdout);
    const short = project.id.slice(0, 12);

    const updated = await runOk(home, ["project", "update", short, "--status", "blocked", "--json"]);
    expect(JSON.parse(updated.stdout).status).toBe("blocked");

    const status = await runOk(home, ["project", "status", short, "--json"]);
    const progress = JSON.parse(status.stdout);
    expect(progress.counts.total).toBe(0);
    expect(progress.percentDone).toBe(0);
  });

  it("invalid project transition exits non-zero", async () => {
    const home = await freshHome();
    await runOk(home, ["init"]);
    await runOk(home, ["area", "add", "K", "--slug", "k", "--importance", "3"]);
    const add = await runOk(home, ["project", "add", "P1", "--area", "k", "--json"]);
    const project = JSON.parse(add.stdout);

    await runOk(home, ["project", "update", project.id, "--status", "done"]);
    // done → blocked is rejected by the project state machine
    const r = await runCli(home, ["project", "update", project.id, "--status", "blocked"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("Invalid project status transition");
  });

  it("project status on unknown short prefix surfaces 'project not found'", async () => {
    const home = await freshHome();
    await runOk(home, ["init"]);
    const r = await runCli(home, ["project", "status", "00000000"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("project not found");
  });
});

// ──────────────────────────────────────────────────────────────────────
// Prioritizer
// ──────────────────────────────────────────────────────────────────────

describe("next (prioritizer)", () => {
  it("returns tasks ranked by score", async () => {
    const home = await freshHome();
    await runOk(home, ["init"]);
    await runOk(home, ["area", "add", "K", "--slug", "k", "--importance", "5"]);

    // Low-priority background task
    await runOk(home, ["add", "Newsletter", "--area", "k", "--priority", "1"]);
    // Urgent due task
    const dueSoon = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await runOk(home, ["add", "Wire payment", "--area", "k", "--priority", "5", "--due", dueSoon]);

    const next = await runOk(home, ["next", "--limit", "5", "--json"]);
    const results = JSON.parse(next.stdout);
    expect(results.length).toBe(2);
    // Urgent task should be first
    expect(results[0].task.title).toBe("Wire payment");
    expect(results[0].score.urgency).toBeGreaterThan(0);
    expect(results[0].score.total).toBeGreaterThan(results[1].score.total);
  });

  it("returns empty list cleanly when no tasks", async () => {
    const home = await freshHome();
    await runOk(home, ["init"]);
    const r = await runOk(home, ["next", "--json"]);
    expect(JSON.parse(r.stdout)).toEqual([]);
  });

  it("defer filter: hides far-future --schedule tasks; --include-scheduled / --include-deferred surface them", async () => {
    const home = await freshHome();
    await runOk(home, ["init"]);
    await runOk(home, ["area", "add", "K", "--slug", "k", "--importance", "3"]);
    await runOk(home, ["add", "deferred", "--area", "k", "--schedule", "2099-01-01T00:00:00Z"]);
    await runOk(home, ["add", "normal", "--area", "k"]);

    // next: deferred hidden by default
    const next = await runOk(home, ["next", "--json"]);
    expect(JSON.parse(next.stdout).map((r: any) => r.task.title)).toEqual(["normal"]);

    // next: --include-scheduled surfaces the deferred task
    const nextAll = await runOk(home, ["next", "--include-scheduled", "--json"]);
    expect(JSON.parse(nextAll.stdout).map((r: any) => r.task.title).sort()).toEqual([
      "deferred",
      "normal",
    ]);

    // list: mirrors the defer filter
    const list = await runOk(home, ["list", "--json"]);
    expect(JSON.parse(list.stdout).map((t: any) => t.title)).toEqual(["normal"]);

    const listAll = await runOk(home, ["list", "--include-scheduled", "--json"]);
    expect(JSON.parse(listAll.stdout).map((t: any) => t.title).sort()).toEqual([
      "deferred",
      "normal",
    ]);

    // --include-deferred alias also works on list
    const listAlias = await runOk(home, ["list", "--include-deferred", "--json"]);
    expect(JSON.parse(listAlias.stdout).map((t: any) => t.title).sort()).toEqual([
      "deferred",
      "normal",
    ]);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Inbox + search
// ──────────────────────────────────────────────────────────────────────

describe("inbox + search", () => {
  it("inbox returns only tasks without project", async () => {
    const home = await freshHome();
    await runOk(home, ["init"]);
    await runOk(home, ["area", "add", "K", "--slug", "k", "--importance", "3"]);

    const proj = await runOk(home, ["project", "add", "P1", "--area", "k", "--json"]);
    const projectId = JSON.parse(proj.stdout).id;

    await runOk(home, ["add", "in-project", "--area", "k", "--project", projectId]);
    await runOk(home, ["add", "orphan-1", "--area", "k"]);
    await runOk(home, ["add", "orphan-2", "--area", "k"]);

    const inbox = await runOk(home, ["inbox", "--json"]);
    const list = JSON.parse(inbox.stdout);
    expect(list.length).toBe(2);
    expect(list.every((t: any) => t.projectId == null)).toBe(true);
  });

  it("search matches title/description/next_action", async () => {
    const home = await freshHome();
    await runOk(home, ["init"]);
    await runOk(home, ["area", "add", "K", "--slug", "k", "--importance", "3"]);
    await runOk(home, ["add", "Outline pitch deck", "--area", "k"]);
    await runOk(home, ["add", "Wire payment", "--area", "k", "--next", "Click ACH in Mercury"]);

    const r = await runOk(home, ["search", "mercury", "--json"]);
    const hits = JSON.parse(r.stdout);
    expect(hits.length).toBe(1);
    expect(hits[0].title).toBe("Wire payment");
  });
});

// ──────────────────────────────────────────────────────────────────────
// Projection
// ──────────────────────────────────────────────────────────────────────

describe("projection", () => {
  it("writes markdown to configured target", async () => {
    const home = await freshHome();
    const target = join(home, "TASKS.md");
    await runOk(home, ["init"]);
    await runOk(home, ["config", "set", "projectionTarget", target]);
    await runOk(home, ["area", "add", "Kami", "--slug", "kami", "--importance", "5"]);
    await runOk(home, ["add", "Test", "--area", "kami", "--next", "do it"]);

    await runOk(home, ["projection"]);

    expect(existsSync(target)).toBe(true);
    const md = readFileSync(target, "utf-8");
    expect(md).toContain("AUTO-GENERATED by tasq");
    expect(md).toContain("Kami");
    expect(md).toContain("Test");
  });

  it("auto-regenerates on mutations when target configured", async () => {
    const home = await freshHome();
    const target = join(home, "TASKS.md");
    await runOk(home, ["init"]);
    await runOk(home, ["config", "set", "projectionTarget", target]);
    await runOk(home, ["area", "add", "Kami", "--slug", "kami", "--importance", "5"]);

    // Initial state shouldn't have "FreshTask"
    let md = readFileSync(target, "utf-8");
    expect(md).not.toContain("FreshTask");

    await runOk(home, ["add", "FreshTask", "--area", "kami"]);
    md = readFileSync(target, "utf-8");
    expect(md).toContain("FreshTask");
  });

  it("projection without --target prints to stdout", async () => {
    const home = await freshHome();
    await runOk(home, ["init"]);
    await runOk(home, ["area", "add", "K", "--slug", "k", "--importance", "3"]);
    await runOk(home, ["add", "T", "--area", "k"]);

    const r = await runOk(home, ["projection"]);
    expect(r.stdout).toContain("AUTO-GENERATED by tasq");
    expect(r.stdout).toContain("T");
  });
});

// ──────────────────────────────────────────────────────────────────────
// Sub-tasks (v0.2)
// ──────────────────────────────────────────────────────────────────────

describe("sub-tasks + tree + status", () => {
  it("--parent creates a sub-task inheriting area from parent", async () => {
    const home = await freshHome();
    await runOk(home, ["init"]);
    await runOk(home, ["area", "add", "Kami", "--slug", "kami", "--importance", "5"]);

    const parentAdd = await runOk(home, ["add", "Renover salon", "--area", "kami", "--json"]);
    const parent = JSON.parse(parentAdd.stdout);

    const childAdd = await runOk(home, [
      "add",
      "Choisir peinture",
      "--parent",
      parent.id,
      "--json",
    ]);
    const child = JSON.parse(childAdd.stdout);

    expect(child.parentTaskId).toBe(parent.id);
    expect(child.areaId).toBe(parent.areaId); // inheritance
  });

  it("`tasq tree` returns root + descendants in BFS order", async () => {
    const home = await freshHome();
    await runOk(home, ["init"]);
    await runOk(home, ["area", "add", "K", "--slug", "k", "--importance", "3"]);
    const root = JSON.parse((await runOk(home, ["add", "root", "--area", "k", "--json"])).stdout);
    const c1 = JSON.parse(
      (await runOk(home, ["add", "c1", "--parent", root.id, "--json"])).stdout,
    );
    await runOk(home, ["add", "gc1", "--parent", c1.id]);

    const tree = JSON.parse((await runOk(home, ["tree", root.id, "--json"])).stdout);
    expect(tree.length).toBe(3);
    expect(tree[0].title).toBe("root");
  });

  it("`tasq next` excludes parents with open sub-tasks", async () => {
    const home = await freshHome();
    await runOk(home, ["init"]);
    await runOk(home, ["area", "add", "K", "--slug", "k", "--importance", "5"]);
    const parent = JSON.parse(
      (await runOk(home, ["add", "Parent", "--area", "k", "--json"])).stdout,
    );
    await runOk(home, ["add", "Child", "--parent", parent.id]);

    const next = JSON.parse((await runOk(home, ["next", "--limit", "5", "--json"])).stdout);
    const ids = next.map((r: { task: { id: string } }) => r.task.id);
    expect(ids).not.toContain(parent.id);
    expect(ids.length).toBe(1); // only child
  });

  it("`tasq task status <id>` returns progress JSON", async () => {
    const home = await freshHome();
    await runOk(home, ["init"]);
    await runOk(home, ["area", "add", "K", "--slug", "k", "--importance", "3"]);
    const parent = JSON.parse(
      (await runOk(home, ["add", "P", "--area", "k", "--json"])).stdout,
    );
    const c1 = JSON.parse(
      (await runOk(home, ["add", "c1", "--parent", parent.id, "--json"])).stdout,
    );
    await runOk(home, ["add", "c2", "--parent", parent.id]);
    await runOk(home, ["done", c1.id]);

    const status = JSON.parse(
      (await runOk(home, ["task", "status", parent.id, "--json"])).stdout,
    );
    expect(status.percentDone).toBe(50);
    expect(status.counts.done).toBe(1);
    expect(status.counts.open).toBe(1);
  });

  it("`tasq project status <id>` returns progress JSON for projects", async () => {
    const home = await freshHome();
    await runOk(home, ["init"]);
    await runOk(home, ["area", "add", "K", "--slug", "k", "--importance", "3"]);
    const proj = JSON.parse(
      (await runOk(home, ["project", "add", "Pitch deck", "--area", "k", "--json"]))
        .stdout,
    );
    const t1 = JSON.parse(
      (
        await runOk(home, [
          "add",
          "Outline",
          "--area",
          "k",
          "--project",
          proj.id,
          "--json",
        ])
      ).stdout,
    );
    await runOk(home, [
      "add",
      "Section 1",
      "--area",
      "k",
      "--project",
      proj.id,
    ]);
    await runOk(home, ["done", t1.id]);

    const status = JSON.parse(
      (await runOk(home, ["project", "status", proj.id, "--json"])).stdout,
    );
    expect(status.percentDone).toBe(50);
    expect(status.counts.total).toBe(2);
  });

  it("rejects sub-task creation beyond max depth 5", async () => {
    const home = await freshHome();
    await runOk(home, ["init"]);
    await runOk(home, ["area", "add", "K", "--slug", "k", "--importance", "3"]);

    let currentId = JSON.parse(
      (await runOk(home, ["add", "d1", "--area", "k", "--json"])).stdout,
    ).id;
    for (let d = 2; d <= 5; d++) {
      const r = await runOk(home, ["add", `d${d}`, "--parent", currentId, "--json"]);
      currentId = JSON.parse(r.stdout).id;
    }
    // 6th level should fail with exit code != 0
    const overflow = await runCli(home, ["add", "d6", "--parent", currentId]);
    expect(overflow.exitCode).not.toBe(0);
    expect(overflow.stderr).toContain("exceeds max depth");
  });
});

// ──────────────────────────────────────────────────────────────────────
// Concurrent CLI invocations (WAL mode)
// ──────────────────────────────────────────────────────────────────────

describe("concurrency", () => {
  it("5 simultaneous adds all succeed (WAL + retry handle contention)", async () => {
    const home = await freshHome();
    await runOk(home, ["init"]);
    await runOk(home, ["area", "add", "K", "--slug", "k", "--importance", "3"]);

    const adds = await Promise.all(
      [1, 2, 3, 4, 5].map((i) =>
        runOk(home, ["add", `t${i}`, "--area", "k", "--json"]),
      ),
    );

    expect(adds.every((r) => r.exitCode === 0)).toBe(true);

    // Verify 5 distinct rows landed (rules out a silent lost write where the
    // process exits 0 but the row was never committed) and that each id is
    // unique.
    const list = await runOk(home, ["list", "--json"]);
    const tasks = JSON.parse(list.stdout);
    expect(tasks.length).toBe(5);
    const titles = new Set(tasks.map((t: { title: string }) => t.title));
    expect(titles).toEqual(new Set(["t1", "t2", "t3", "t4", "t5"]));
    const ids = new Set(tasks.map((t: { id: string }) => t.id));
    expect(ids.size).toBe(5);

    // Event log records each create exactly once.
    const events = await runOk(home, ["event", "list", "--limit", "100", "--json"]);
    const creates = JSON.parse(events.stdout).filter(
      (e: { entityType: string; eventType: string }) =>
        e.entityType === "task" && e.eventType === "created",
    );
    expect(creates.length).toBe(5);
  });

  it("20 simultaneous adds — stress check, no lost writes", async () => {
    // Harder version of the test above. If retry isn't wired or busy_timeout
    // is too low, this is the case that flakes.
    const home = await freshHome();
    await runOk(home, ["init"]);
    await runOk(home, ["area", "add", "K", "--slug", "k", "--importance", "3"]);

    const adds = await Promise.all(
      Array.from({ length: 20 }, (_, i) => i + 1).map((i) =>
        runOk(home, ["add", `t${i}`, "--area", "k", "--json"]),
      ),
    );

    expect(adds.every((r) => r.exitCode === 0)).toBe(true);
    const list = await runOk(home, ["list", "--limit", "100", "--json"]);
    expect(JSON.parse(list.stdout).length).toBe(20);
  });

  it("a single `add` produces exactly ONE task + ONE 'created' event (no double-apply)", async () => {
    const home = await freshHome();
    await runOk(home, ["init"]);
    await runOk(home, ["area", "add", "K", "--slug", "k", "--importance", "3"]);

    await runOk(home, ["add", "solo", "--area", "k"]);

    // No internal retry double-applied the mutation: one row, one event.
    const list = await runOk(home, ["list", "--json"]);
    expect(JSON.parse(list.stdout).length).toBe(1);

    const events = await runOk(home, ["event", "list", "--limit", "100", "--json"]);
    const creates = JSON.parse(events.stdout).filter(
      (e: { entityType: string; eventType: string }) =>
        e.entityType === "task" && e.eventType === "created",
    );
    expect(creates.length).toBe(1);
  });

  it("`add` is NOT idempotent — running it twice creates TWO tasks", async () => {
    // Documents the corrected mental model: each `tasq add` mints a fresh
    // uuidv7, so a whole-command replay would DUPLICATE (which is exactly why
    // runWithRetry no longer replays mutating commands). Two explicit adds of
    // the same title therefore yield two distinct rows + two 'created' events.
    const home = await freshHome();
    await runOk(home, ["init"]);
    await runOk(home, ["area", "add", "K", "--slug", "k", "--importance", "3"]);

    const a = JSON.parse((await runOk(home, ["add", "dup", "--area", "k", "--json"])).stdout);
    const b = JSON.parse((await runOk(home, ["add", "dup", "--area", "k", "--json"])).stdout);
    expect(a.id).not.toBe(b.id);

    const list = await runOk(home, ["list", "--json"]);
    const dups = JSON.parse(list.stdout).filter((t: { title: string }) => t.title === "dup");
    expect(dups.length).toBe(2);

    const events = await runOk(home, ["event", "list", "--limit", "100", "--json"]);
    const creates = JSON.parse(events.stdout).filter(
      (e: { entityType: string; eventType: string }) =>
        e.entityType === "task" && e.eventType === "created",
    );
    expect(creates.length).toBe(2);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Durability — event journal + backup
// ──────────────────────────────────────────────────────────────────────

describe("durability", () => {
  it("doctor verifies SQLite, invariants, journal parity and permissions", async () => {
    const home = await freshHome();
    await runOk(home, ["init"]);
    await runOk(home, ["add", "healthy"]);
    const result = await runOk(home, ["doctor", "--json"]);
    const report = JSON.parse(result.stdout);
    expect(report.ok).toBe(true);
    expect(report.store.sqliteIntegrity).toBe("ok");
    expect(report.journal.databaseOnly).toEqual([]);
    expect(report.journal.databaseMaxSequence).toBe(1);
    expect(report.journal.journalMaxSequence).toBe(1);
    expect(report.journal.commonMaxSequence).toBe(1);
    expect(report.journal.sequenceMismatches).toEqual([]);
    expect(report.outbox).toMatchObject({
      pending: 0,
      delivering: 0,
      delivered: 1,
      quarantined: 0,
      repairs: [],
    });
    expect(report.permissionIssues).toEqual([]);
  });

  it("doctor explicitly redelivers an acknowledged event missing from the journal", async () => {
    const home = await freshHome();
    await runOk(home, ["init"]);
    await runOk(home, ["add", "repair delivery"]);
    const journalPath = join(home, ".tasq", "events.jsonl");
    writeFileSync(journalPath, "", { mode: 0o600 });

    const broken = await runCli(home, ["doctor", "--json"]);
    expect(broken.exitCode).toBe(1);
    expect(JSON.parse(broken.stdout).journal.databaseOnly).toHaveLength(1);

    const repaired = await runOk(home, ["doctor", "--repair-outbox", "--json"]);
    const report = JSON.parse(repaired.stdout);
    expect(report.ok).toBe(true);
    expect(report.journal.databaseOnly).toEqual([]);
    expect(report.outbox).toMatchObject({
      pending: 0,
      delivering: 0,
      delivered: 1,
      quarantined: 0,
    });
    expect(report.outbox.repairs).toEqual([
      expect.objectContaining({ from: "delivered", action: "redeliver" }),
    ]);
    expect(readFileSync(journalPath, "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("doctor reports private-mode drift without mutating it and repairs only when asked", async () => {
    const home = await freshHome();
    await runOk(home, ["init"]);
    await runOk(home, ["add", "private"]);
    const dir = join(home, ".tasq");
    const paths = [
      dir,
      join(dir, "config.json"),
      join(dir, "db.sqlite"),
      join(dir, "events.jsonl"),
    ];
    chmodSync(paths[0]!, 0o755);
    for (const path of paths.slice(1)) chmodSync(path, 0o644);

    const observed = await runCli(home, ["doctor", "--json"]);
    expect(observed.exitCode).toBe(1);
    const observedReport = JSON.parse(observed.stdout);
    expect(observedReport.permissionIssues).toHaveLength(4);
    expect(observedReport.permissionRepairs).toEqual([]);
    expect(lstatSync(paths[0]!).mode & 0o777).toBe(0o755);
    expect(lstatSync(paths[1]!).mode & 0o777).toBe(0o644);

    const repaired = JSON.parse((await runOk(home, [
      "doctor", "--fix-permissions", "--json",
    ])).stdout);
    expect(repaired.ok).toBe(true);
    expect(repaired.permissionIssues).toEqual([]);
    expect(repaired.permissionRepairs).toHaveLength(4);
    expect(lstatSync(paths[0]!).mode & 0o777).toBe(0o700);
    for (const path of paths.slice(1)) {
      expect(lstatSync(path).mode & 0o777).toBe(0o600);
    }
  });

  it("doctor rejects a journal event whose sequence disagrees with the database", async () => {
    const home = await freshHome();
    await runOk(home, ["init"]);
    await runOk(home, ["add", "healthy"]);
    const journalPath = join(home, ".tasq", "events.jsonl");
    const event = JSON.parse(readFileSync(journalPath, "utf8").trim());
    event.sequence = 99;
    writeFileSync(journalPath, JSON.stringify(event) + "\n", { mode: 0o600 });

    const result = await runCli(home, ["doctor", "--json"]);
    expect(result.exitCode).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report.journal.databaseMaxSequence).toBe(1);
    expect(report.journal.journalMaxSequence).toBe(99);
    expect(report.journal.commonMaxSequence).toBe(0);
    expect(report.journal.sequenceMismatches).toEqual([{
      id: event.id,
      databaseSequence: 1,
      journalSequence: 99,
    }]);
  });

  it("doctor recognizes pre-sequence journal entries by event identity", async () => {
    const home = await freshHome();
    await runOk(home, ["init"]);
    await runOk(home, ["area", "add", "K", "--slug", "k", "--importance", "3"]);
    await runOk(home, ["add", "legacy journal task", "--area", "k"]);
    const journalPath = join(home, ".tasq", "events.jsonl");
    const legacy = readFileSync(journalPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => {
        const event = JSON.parse(line);
        delete event.sequence;
        return JSON.stringify(event);
      })
      .join("\n") + "\n";
    writeFileSync(journalPath, legacy, { mode: 0o600 });

    const result = await runOk(home, ["doctor", "--json"]);
    const report = JSON.parse(result.stdout);
    expect(report.ok).toBe(true);
    expect(report.journal.legacyUnsequencedEvents).toBe(2);
    expect(report.journal.malformedLines).toBe(0);
    expect(report.journal.databaseMaxSequence).toBe(2);
    expect(report.journal.journalMaxSequence).toBe(2);
    expect(report.journal.commonMaxSequence).toBe(2);
  });

  it("checkpoints a divergent journal into a verified segment and resumes exact parity", async () => {
    const home = await freshHome();
    await runOk(home, ["init"]);
    await runOk(home, ["area", "add", "K", "--slug", "k", "--importance", "3"]);
    await runOk(home, ["add", "before checkpoint", "--area", "k"]);
    const journalPath = join(home, ".tasq", "events.jsonl");
    appendFileSync(journalPath, JSON.stringify({
      id: "01900000-0000-7000-8000-000000000099",
      actor: "legacy",
      entityType: "task",
      entityId: "01900000-0000-7000-8000-000000000098",
      eventType: "created",
      createdAt: 1,
    }) + "\n");
    expect((await runCli(home, ["doctor", "--json"])).exitCode).toBe(1);

    const refused = await runCli(home, [
      "journal", "checkpoint", "--reason", "accept restored DB",
    ]);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("--accept-database");

    const first = JSON.parse((await runOk(home, [
      "journal", "checkpoint", "--accept-database",
      "--reason", "accept restored DB", "--actor", "operator", "--json",
    ])).stdout);
    expect(first.ok).toBe(true);
    expect(first.reused).toBe(false);
    expect(first.checkpoint.databaseCursor).toBe(2);
    expect(first.checkpoint.databaseEventId).toBeString();
    expect(first.checkpoint.previousSegment.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(first.archivePath)).toBe(true);
    expect(statSync(first.archivePath).size).toBe(first.checkpoint.previousSegment.sizeBytes);

    const repeated = JSON.parse((await runOk(home, [
      "journal", "checkpoint", "--accept-database",
      "--reason", "retry after lost response", "--actor", "operator", "--json",
    ])).stdout);
    expect(repeated.reused).toBe(true);
    expect(repeated.checkpoint).toEqual(first.checkpoint);
    expect(repeated.archivePath).toBe(first.archivePath);

    const healthy = JSON.parse((await runOk(home, ["doctor", "--json"])).stdout);
    expect(healthy.ok).toBe(true);
    expect(healthy.journal.checkpoint.databaseCursor).toBe(2);
    expect(healthy.journal.checkpoint.archiveVerified).toBe(true);
    expect(healthy.journal.databaseOnly).toEqual([]);
    expect(healthy.journal.journalOnly).toEqual([]);

    await runOk(home, ["add", "after checkpoint", "--area", "k"]);
    const resumed = JSON.parse((await runOk(home, ["doctor", "--json"])).stdout);
    expect(resumed.ok).toBe(true);
    expect(resumed.journal.databaseMaxSequence).toBe(3);
    expect(resumed.journal.journalMaxSequence).toBe(3);
    expect(resumed.journal.commonMaxSequence).toBe(3);
    expect(readFileSync(journalPath, "utf8").trim().split("\n")).toHaveLength(2);

    await runOk(home, [
      "journal", "checkpoint", "--accept-database",
      "--reason", "second segment", "--actor", "operator", "--json",
    ]);
    const chained = JSON.parse((await runOk(home, ["doctor", "--json"])).stdout);
    expect(chained.journal.checkpoint.archiveVerified).toBe(true);
    expect(chained.journal.checkpoint.archiveSegments).toBe(2);

    appendFileSync(first.archivePath, "tamper\n");
    const tampered = await runCli(home, ["doctor", "--json"]);
    expect(tampered.exitCode).toBe(1);
    expect(
      JSON.parse(tampered.stdout).journal.checkpointIssues.some((issue: string) =>
        issue.includes("does not match its size/SHA-256"),
      ),
    ).toBe(true);
  });

  it("event journal receives one line per emitted task-scoped event", async () => {
    const home = await freshHome();
    await runOk(home, ["init"]);
    await runOk(home, ["area", "add", "K", "--slug", "k", "--importance", "3"]);
    const add = await runOk(home, ["add", "t1", "--area", "k", "--json"]);
    const task = JSON.parse(add.stdout);
    await runOk(home, ["done", task.id]);

    const journalPath = join(home, ".tasq", "events.jsonl");
    expect(existsSync(journalPath)).toBe(true);

    const lines = readFileSync(journalPath, "utf-8").trim().split("\n");
    // area created (1) + task created (1) + task completed (1) = 3 events
    expect(lines.length).toBe(3);

    const events = lines.map((l) => JSON.parse(l));
    expect(events.map((e) => e.eventType)).toEqual(["created", "created", "completed"]);
    expect(events.map((e) => e.entityType)).toEqual(["area", "task", "task"]);
    // Each line is a self-contained event with required fields
    for (const e of events) {
      expect(typeof e.id).toBe("string");
      expect(typeof e.actor).toBe("string");
      expect(typeof e.createdAt).toBe("number");
    }
  });

  it("event journal remains forensic evidence after a DB wipe", async () => {
    const home = await freshHome();
    await runOk(home, ["init"]);
    await runOk(home, ["area", "add", "K", "--slug", "k", "--importance", "3"]);
    await runOk(home, ["add", "important task", "--area", "k"]);

    const journalPath = join(home, ".tasq", "events.jsonl");
    const linesBefore = readFileSync(journalPath, "utf-8").trim().split("\n");
    expect(linesBefore.length).toBe(2);

    // Simulate the disaster: an agent rm'd the DB
    const { rmSync } = await import("node:fs");
    rmSync(join(home, ".tasq", "db.sqlite"));
    rmSync(join(home, ".tasq", "db.sqlite-wal"), { force: true });
    rmSync(join(home, ".tasq", "db.sqlite-shm"), { force: true });

    // Journal is untouched — recovery is possible
    expect(existsSync(journalPath)).toBe(true);
    const linesAfter = readFileSync(journalPath, "utf-8").trim().split("\n");
    expect(linesAfter).toEqual(linesBefore);
    const events = linesAfter.map((l) => JSON.parse(l));
    expect(events[1].payload.after.title).toBe("important task");
  });

  it("tasq backup writes a self-contained SQLite snapshot", async () => {
    const home = await freshHome();
    await runOk(home, ["init"]);
    await runOk(home, ["area", "add", "K", "--slug", "k", "--importance", "3"]);
    await runOk(home, ["add", "task to back up", "--area", "k"]);

    const target = join(home, "my-backup.sqlite");
    const r = await runOk(home, ["backup", target, "--json"]);
    const result = JSON.parse(r.stdout);
    expect(result.ok).toBe(true);
    expect(result.target).toBe(target);
    expect(result.sizeBytes).toBeGreaterThan(0);
    expect(result.eventCursor).toBe(2);
    expect(existsSync(target)).toBe(true);
  });

  it("restores a snapshot into an isolated home and verifies the journal cursor", async () => {
    const sourceHome = await freshHome();
    await runOk(sourceHome, ["init"]);
    await runOk(sourceHome, ["area", "add", "K", "--slug", "k", "--importance", "3"]);
    await runOk(sourceHome, ["add", "present in snapshot", "--area", "k"]);

    const snapshot = join(sourceHome, "drill.sqlite");
    const backup = JSON.parse((await runOk(sourceHome, ["backup", snapshot, "--json"])).stdout);
    const backupCursor = backup.eventCursor;
    expect(backupCursor).toBe(2);

    const sourceJournal = join(sourceHome, ".tasq", "events.jsonl");
    const journalAtBackup = readFileSync(sourceJournal, "utf8");

    // Advance the source after the snapshot. A restore paired with this newer
    // journal must report that the journal is ahead instead of looking healthy.
    await runOk(sourceHome, ["add", "created after snapshot", "--area", "k"]);
    const journalAfterBackup = readFileSync(sourceJournal, "utf8");

    const restoreHome = await freshHome();
    const restoreDir = join(restoreHome, ".tasq");
    const restoredDb = join(restoreDir, "db.sqlite");
    const restoredJournal = join(restoreDir, "events.jsonl");
    mkdirSync(restoreDir, { recursive: true, mode: 0o700 });
    copyFileSync(snapshot, restoredDb);
    chmodSync(restoredDb, 0o600);
    writeFileSync(restoredJournal, journalAfterBackup, { mode: 0o600 });

    const ahead = await runCli(restoreHome, ["doctor", "--json"]);
    expect(ahead.exitCode).toBe(1);
    const aheadReport = JSON.parse(ahead.stdout);
    expect(aheadReport.store.ok).toBe(true);
    expect(aheadReport.journal.databaseMaxSequence).toBe(backupCursor);
    expect(aheadReport.journal.journalMaxSequence).toBe(backupCursor + 1);
    expect(aheadReport.journal.commonMaxSequence).toBe(backupCursor);
    expect(aheadReport.journal.journalOnly).toHaveLength(1);
    expect(aheadReport.journal.databaseOnly).toEqual([]);

    // Pair the snapshot with the journal captured at the same cursor. This is
    // a copy inside the drill; the source append-only journal is never edited.
    writeFileSync(restoredJournal, journalAtBackup, { mode: 0o600 });
    const healthy = await runOk(restoreHome, ["doctor", "--json"]);
    const healthyReport = JSON.parse(healthy.stdout);
    expect(healthyReport.ok).toBe(true);
    expect(healthyReport.journal.databaseMaxSequence).toBe(backupCursor);
    expect(healthyReport.journal.journalMaxSequence).toBe(backupCursor);
    expect(healthyReport.journal.commonMaxSequence).toBe(backupCursor);

    const restoredTasks = JSON.parse((await runOk(restoreHome, ["list", "--json"])).stdout);
    expect(restoredTasks.map((task: { title: string }) => task.title)).toEqual([
      "present in snapshot",
    ]);

    await runOk(restoreHome, ["add", "first task after restore", "--area", "k"]);
    const resumed = JSON.parse((await runOk(restoreHome, ["doctor", "--json"])).stdout);
    expect(resumed.ok).toBe(true);
    expect(resumed.journal.databaseMaxSequence).toBe(backupCursor + 1);
    expect(resumed.journal.journalMaxSequence).toBe(backupCursor + 1);
  });

  it("tasq backup --rotate keeps the N most recent snapshots", async () => {
    const home = await freshHome();
    await runOk(home, ["init"]);
    await runOk(home, ["area", "add", "K", "--slug", "k", "--importance", "3"]);

    // Make 3 backups, then a 4th with --rotate 2 — should keep the 2 most recent.
    for (let i = 0; i < 3; i++) {
      await runOk(home, ["backup", "--json"]);
      // tiny delay so mtimes differ enough for sort stability
      await new Promise((r) => setTimeout(r, 25));
    }
    const r = await runOk(home, ["backup", "--rotate", "2", "--json"]);
    const out = JSON.parse(r.stdout);
    expect(out.rotated.length).toBeGreaterThanOrEqual(2);

    const snapDir = join(home, ".tasq", "snapshots");
    const remaining = require("node:fs")
      .readdirSync(snapDir)
      .filter((f: string) => f.startsWith("db-") && f.endsWith(".sqlite"));
    expect(remaining.length).toBe(2);
  });

  it("config get eventJournalPath returns the default", async () => {
    const home = await freshHome();
    await runOk(home, ["init"]);
    const r = await runOk(home, ["config", "get", "eventJournalPath", "--json"]);
    expect(JSON.parse(r.stdout).eventJournalPath).toBe(join(home, ".tasq", "events.jsonl"));
  });
});

// ──────────────────────────────────────────────────────────────────────
// Regressions (found via real use 2026-06-02)
// ──────────────────────────────────────────────────────────────────────

describe("regression: --actor + --metadata", () => {
  it("area add honors --actor (was ignored: always defaultActor)", async () => {
    const home = await freshHome();
    await runOk(home, ["init"]);
    await runOk(home, ["area", "add", "Body", "--slug", "body", "--actor", "claude"]);
    const r = await runOk(home, ["event", "list", "--actor", "claude", "--json"]);
    const events = JSON.parse(r.stdout);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events.every((e: { actor: string }) => e.actor === "claude")).toBe(true);
    expect(events.some((e: { entityType: string; eventType: string }) =>
      e.entityType === "area" && e.eventType === "created")).toBe(true);
  });

  it("task add + update persist --metadata (was silently dropped)", async () => {
    const home = await freshHome();
    await runOk(home, ["init"]);
    await runOk(home, ["area", "add", "Inbox", "--slug", "inbox"]);
    const add = await runOk(home, [
      "add", "Ship it", "--area", "inbox",
      "--metadata", '{"legacyId":"42","captured_from":"2026-06-02"}', "--json",
    ]);
    const id = JSON.parse(add.stdout).id;
    const shown = await runOk(home, ["show", id, "--json"]);
    expect(JSON.parse(shown.stdout).metadata).toEqual({ legacyId: "42", captured_from: "2026-06-02" });

    await runOk(home, ["update", id, "--metadata", '{"tier":"private"}']);
    const after = await runOk(home, ["show", id, "--json"]);
    expect(JSON.parse(after.stdout).metadata).toEqual({ tier: "private" });
  });

  it("add rejects invalid --metadata JSON with a clean error", async () => {
    const home = await freshHome();
    await runOk(home, ["init"]);
    await runOk(home, ["area", "add", "Inbox", "--slug", "inbox"]);
    const r = await runCli(home, ["add", "X", "--area", "inbox", "--metadata", "not json"]);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("metadata must be valid JSON");
  });
});

// ──────────────────────────────────────────────────────────────────────
// Recurrence (SPEC §6.4-H)
// ──────────────────────────────────────────────────────────────────────

describe("recurrence", () => {
  const DAY = 24 * 60 * 60 * 1000;

  it("add --recurrence weekly --due, done → spawns next open instance ~7d later", async () => {
    const home = await freshHome();
    await runOk(home, ["init"]);
    await runOk(home, ["area", "add", "Home", "--slug", "home", "--importance", "3"]);

    const dueIso = new Date(Date.now() + 2 * DAY).toISOString();
    const add = await runOk(home, [
      "add", "water plants", "--area", "home",
      "--recurrence", "weekly", "--interval", "1", "--anchor", "due",
      "--due", dueIso, "--json",
    ]);
    const orig = JSON.parse(add.stdout);
    expect(orig.recurrence).toBe("weekly");

    await runOk(home, ["done", orig.id, "--json"]);

    // The spawned instance is open with a due ~7 days after the original due.
    // (include-scheduled so a future-dated instance still shows in `list`.)
    const list = await runOk(home, ["list", "--status", "open", "--include-scheduled", "--json"]);
    const open = JSON.parse(list.stdout);
    expect(open.length).toBe(1);
    expect(open[0].title).toBe("water plants");
    expect(open[0].recurrence).toBe("weekly");
    const origDue = Date.parse(dueIso);
    expect(Math.round((open[0].dueAt - origDue) / DAY)).toBe(7);

    // show --json on the original surfaces recurrence + last_done_at.
    const shown = await runOk(home, ["show", orig.id, "--json"]);
    const body = JSON.parse(shown.stdout);
    expect(body.recurrence).toBe("weekly");
    expect(body.lastDoneAt).toBeGreaterThan(0);
    expect(body.status).toBe("done");
  });

  it("invalid --recurrence value exits with validation code 2", async () => {
    const home = await freshHome();
    await runOk(home, ["init"]);
    await runOk(home, ["area", "add", "Home", "--slug", "home"]);
    const r = await runCli(home, ["add", "x", "--area", "home", "--recurrence", "hourly"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("Invalid value for --recurrence");
  });
});
