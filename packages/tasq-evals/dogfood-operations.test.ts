import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const root = resolve(import.meta.dir, "../..");
const temporary = mkdtempSync(join(tmpdir(), "tasq-dogfood-operations-"));
const statusPath = join(temporary, "status.json");
const fixture = JSON.parse(readFileSync(resolve(root, "docs/contracts/TQ-607_DOGFOOD_STATUS.json"), "utf8"));
fixture.revision = 1;
fixture.status = "program-open-evidence-pending";
fixture.earliestDecisionAt = fixture.initialEarliestDecisionAt;
fixture.baseline = null;
fixture.currentPhase = "baseline_and_activation";
fixture.nextAction = "Record the exact candidate version and commit, then verify the first isolated backup and attach its evidence.";
fixture.phases = [
  { id: "baseline_and_activation", state: "in_progress" },
  { id: "first_complete_journeys", state: "pending" },
  { id: "repeated_operation", state: "pending" },
  { id: "resilience_drills", state: "pending" },
  { id: "decision_review", state: `blocked_until_${fixture.initialEarliestDecisionAt}` },
];
for (const consumer of fixture.consumers) {
  consumer.state = "not_started";
  consumer.completedJourneys = [];
  consumer.evidence = [];
  if (consumer.id === "personal-life-pilot") {
    consumer.activeUseDates = [];
    consumer.recordedActiveUseDays = 0;
  }
}
Object.assign(fixture.crossCuttingEvidence, {
  completedForwardUpgradeDrills: 0,
  forwardUpgradeEvidence: [],
  backupRestoreCompleted: false,
  backupRestoreEvidence: [],
  replacementActorRecoveryCompleted: false,
  replacementActorRecoveryEvidence: [],
  coldAgentOnboardingCompleted: false,
  coldAgentOnboardingEvidence: [],
  supportBundleReviewCompleted: false,
  supportBundleReviewEvidence: [],
});
fixture.frictionLog = [];
fixture.unresolvedCriticalFailures = [];
fixture.resolvedCriticalFailures = [];
fixture.audit = [];
fixture.publicLaunchDecision = "undecided";
fixture.decisionRecord = null;
fixture.tq607Complete = false;
writeFileSync(statusPath, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");

afterAll(() => rmSync(temporary, { recursive: true, force: true }));

function run(args: string[]) {
  const child = Bun.spawnSync([
    process.execPath,
    "scripts/dogfood.ts",
    ...args,
    "--file",
    statusPath,
    "--json",
  ], { cwd: root, stdout: "pipe", stderr: "pipe" });
  return {
    exitCode: child.exitCode,
    stdout: child.stdout.toString(),
    stderr: child.stderr.toString(),
    json: child.exitCode === 0 ? JSON.parse(child.stdout.toString()) : null,
  };
}

describe("TQ-607 dogfood operations", () => {
  test("records a baseline atomically and rejects a stale writer", () => {
    const baseline = run([
      "baseline",
      "--expected-revision", "1",
      "--at", "2026-07-22T14:00:00Z",
      "--version", "0.1.0",
      "--commit", "a".repeat(40),
      "--backup-evidence", "evidence/tq-607/baseline.json",
      "--backup-digest", `sha256:${"b".repeat(64)}`,
    ]);
    expect(baseline.exitCode, baseline.stderr).toBe(0);
    expect(baseline.json).toMatchObject({ revision: 2, phase: "first_complete_journeys" });

    const stale = run([
      "use",
      "--expected-revision", "1",
      "--at", "2026-07-22T15:00:00Z",
      "--consumer", "personal-life-pilot",
      "--date", "2026-07-22",
      "--evidence", "evidence/tq-607/day-01.json",
    ]);
    expect(stale.exitCode).not.toBe(0);
    expect(stale.stderr).toContain("Revision conflict");
    expect(JSON.parse(readFileSync(statusPath, "utf8")).revision).toBe(2);
  });

  test("deduplicates use days and drill evidence while retaining revisions", () => {
    const firstUse = run([
      "use", "--expected-revision", "2", "--at", "2026-07-22T16:00:00Z",
      "--consumer", "personal-life-pilot", "--date", "2026-07-22",
      "--evidence", "evidence/tq-607/day-01.json",
    ]);
    expect(firstUse.exitCode, firstUse.stderr).toBe(0);
    const repeatedUse = run([
      "use", "--expected-revision", "3", "--at", "2026-07-22T17:00:00Z",
      "--consumer", "personal-life-pilot", "--date", "2026-07-22",
      "--evidence", "evidence/tq-607/day-01.json",
    ]);
    expect(repeatedUse.json.consumers[0]).toMatchObject({ activeUseDays: 1 });

    const journey = run([
      "journey", "--expected-revision", "4", "--at", "2026-07-22T18:00:00Z",
      "--consumer", "personal-life-pilot",
      "--journey", "open-blocked-resumed-evidence-completed",
      "--evidence", "evidence/tq-607/personal-first-loop.json",
    ]);
    expect(journey.exitCode, journey.stderr).toBe(0);

    const drill = run([
      "drill", "--expected-revision", "5", "--at", "2026-07-22T19:00:00Z",
      "--kind", "forward-upgrade", "--evidence", "evidence/tq-607/upgrade-01.json",
    ]);
    expect(drill.json.drills.forwardUpgrades).toBe("1/2");
    const repeatedDrill = run([
      "drill", "--expected-revision", "6", "--at", "2026-07-22T20:00:00Z",
      "--kind", "forward-upgrade", "--evidence", "evidence/tq-607/upgrade-01.json",
    ]);
    expect(repeatedDrill.json).toMatchObject({ revision: 7, drills: { forwardUpgrades: "1/2" } });
  });

  test("fails closed on an incomplete go but permits a dated extension", () => {
    const go = run([
      "decision", "--expected-revision", "7", "--at", "2026-08-21T09:00:00Z",
      "--value", "go", "--summary", "Not enough real evidence",
      "--evidence", "evidence/tq-607/review.json",
    ]);
    expect(go.exitCode).not.toBe(0);
    expect(go.stderr).toContain("Go requires all consumer journeys");
    expect(JSON.parse(readFileSync(statusPath, "utf8")).revision).toBe(7);

    const extend = run([
      "decision", "--expected-revision", "7", "--at", "2026-08-21T09:00:00Z",
      "--value", "extend", "--summary", "Continue until the missing consumers finish",
      "--evidence", "evidence/tq-607/review.json", "--review-date", "2026-09-04",
    ]);
    expect(extend.exitCode, extend.stderr).toBe(0);
    expect(extend.json).toMatchObject({
      revision: 8,
      status: "program-extended",
      earliestDecisionAt: "2026-09-04",
      publicLaunchDecision: "extend",
      complete: false,
    });
  });

  test("contains no ambient clock or live-ledger access", () => {
    const source = readFileSync(resolve(root, "scripts/dogfood.ts"), "utf8");
    expect(source).not.toContain("Date.now(");
    expect(source).not.toContain("new Date(");
    expect(source).not.toContain("db.sqlite");
    expect(source).not.toContain("@tasq/core");
  });
});
