import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const markdown = readFileSync(resolve(root, "BACKLOG.md"), "utf8");
const roadmap = JSON.parse(readFileSync(resolve(root, "BACKLOG.json"), "utf8")) as {
  contractVersion: string;
  status: string;
  canonicalRepository: string;
  repositoryVisibility: string;
  statusVocabulary: string[];
  invariants: string[];
  externalGates: Record<string, { state: string; observation?: string }>;
  completedPrerequisites: string[];
  decisions: Array<{ id: string; status: string; blocks: string[]; question: string }>;
  executionOrder: string[];
  items: Array<{
    id: string;
    status: string;
    milestone: string;
    dependsOn: string[];
    outcome: string;
    remaining?: string[];
    evidence?: string[];
  }>;
};
const dogfood = JSON.parse(readFileSync(
  resolve(root, "TQ-607_DOGFOOD_STATUS.json"),
  "utf8",
)) as {
  contractVersion: string;
  status: string;
  startedAt: string;
  minimumCalendarDays: number;
  earliestDecisionAt: string;
  currentPhase: string;
  nextAction: string;
  phases: Array<{ id: string; state: string }>;
  consumers: Array<{ id: string; state: string; evidence: unknown[] }>;
  crossCuttingEvidence: Record<string, unknown>;
  frictionLog: unknown[];
  unresolvedCriticalFailures: unknown[];
  publicLaunchDecision: string;
  tq607Complete: boolean;
};

describe("canonical Tasq roadmap", () => {
  test("has one closed status vocabulary and one exact execution order", () => {
    expect(roadmap).toMatchObject({
      contractVersion: "tasq.backlog.v1",
      status: "active",
      canonicalRepository: "https://github.com/gwendall/tasq",
      repositoryVisibility: "private_prelaunch",
      statusVocabulary: [
        "done",
        "in_progress_dogfood",
        "in_progress_external_gate",
        "candidate_done_publication_gate",
        "candidate_done_external_gate",
        "pending",
      ],
    });
    expect(roadmap.items.map(({ id }) => id)).toEqual(roadmap.executionOrder);
    expect(new Set(roadmap.executionOrder).size).toBe(roadmap.executionOrder.length);
    const statuses = new Set(roadmap.statusVocabulary);
    for (const item of roadmap.items) {
      expect(statuses.has(item.status), `${item.id}: unknown status`).toBe(true);
      expect(item.outcome.length, `${item.id}: missing outcome`).toBeGreaterThan(20);
      expect(markdown, `${item.id}: absent from human backlog`).toContain(item.id);
    }
  });

  test("keeps every dependency resolvable without equating an internal slice to a remote product", () => {
    const known = new Set([
      ...roadmap.executionOrder,
      ...roadmap.completedPrerequisites,
      ...roadmap.decisions.map(({ id }) => id),
    ]);
    for (const item of roadmap.items) {
      for (const dependency of item.dependsOn) {
        expect(known.has(dependency), `${item.id}: unknown dependency ${dependency}`).toBe(true);
      }
    }
    expect(roadmap.items.find(({ id }) => id === "TQ-801")).toMatchObject({
      status: "done",
      evidence: ["TQ-801_HOSTED_AUTHORITY_FOUNDATION.md", "TQ-801_AUTHORITY_CERTIFICATION.json"],
    });
    expect(roadmap.items.find(({ id }) => id === "TQ-802")).toMatchObject({
      status: "done",
      evidence: ["TQ-802_AUTHORITY_STORE_ROUTER.md", "TQ-802_AUTHORITY_STORE_CERTIFICATION.json"],
    });
    expect(roadmap.items.find(({ id }) => id === "TQ-803")).toMatchObject({
      status: "done",
      evidence: ["TQ-803_HOSTED_READ_REST.md", "TQ-803_READ_REST_CERTIFICATION.json"],
    });
    expect(roadmap.items.find(({ id }) => id === "TQ-804")).toMatchObject({
      status: "done",
      evidence: ["TQ-804_GUARDED_MUTATION_REST.md", "TQ-804_MUTATION_REST_CERTIFICATION.json"],
    });
    expect(roadmap.items.find(({ id }) => id === "TQ-320")).toMatchObject({
      status: "pending",
      milestone: "runtime-consumers",
      dependsOn: ["TQ-603", "TQ-304", "TQ-501"],
      evidence: ["TQ-320_INTERACTIVE_RUNTIME_CONSUMER.md"],
    });
    for (const item of roadmap.items.filter(({ milestone, id }) => (
      (milestone === "self-hosted-server" || milestone === "managed-cloud") && !["TQ-801", "TQ-802", "TQ-803", "TQ-804"].includes(id)
    ))) {
      expect(item.status, `${item.id}: remote roadmap overstated`).toBe("pending");
    }
  });

  test("states the real publication blockers without inventing ownership", () => {
    expect(roadmap.externalGates).toMatchObject({
      privateMultiAppDogfood: {
        state: "in_progress",
      },
      publicSourceLaunch: {
        state: "blocked_by_private_dogfood_decision",
      },
      npmScopeControl: {
        state: "unverified",
        observation: expect.stringContaining("not evidence of scope ownership"),
      },
      npmTrustedPublishing: { state: "unverified" },
      firstProtectedRelease: { state: "not_run" },
      publishedLifecycleCertification: { state: "blocked_by_first_protected_release" },
      publishedAdoptionCertification: { state: "blocked_by_first_protected_release" },
      independentBlindHumanAdoption: { state: "not_run" },
    });
    expect(roadmap.items[0]).toMatchObject({
      id: "TQ-607",
      status: "in_progress_dogfood",
      milestone: "private-dogfood",
      dependsOn: ["TQ-304", "TQ-501", "TQ-504"],
      remaining: [
        "complete-minimum-duration",
        "complete-three-consumer-journeys",
        "complete-two-live-ledger-upgrades",
        "complete-backup-restore-and-crash-recovery",
        "record-go-extend-or-no-go-decision",
      ],
      evidence: ["TQ-607_PRIVATE_DOGFOOD_GATE.md", "TQ-607_DOGFOOD_STATUS.json"],
    });
    expect(roadmap.items[1]).toMatchObject({
      id: "TQ-603",
      status: "pending",
      dependsOn: ["TQ-607"],
      remaining: [
        "authorize-public-source-launch",
        "restore-and-verify-repository-protections",
        "verify-npm-scope-control",
        "configure-npm-trusted-publishing",
        "publish-first-protected-release",
      ],
    });
    expect(roadmap.items[2]).toMatchObject({
      id: "TQ-604",
      status: "candidate_done_publication_gate",
      evidence: [
        "TQ-604_LIFECYCLE_CERTIFICATION.json",
        "https://github.com/gwendall/tasq/pull/5",
      ],
    });
    expect(roadmap.items.find(({ id }) => id === "TQ-605")).toMatchObject({
      status: "done",
      evidence: ["TQ-605_PUBLIC_SITE.md"],
    });
    expect(roadmap.items.find(({ id }) => id === "TQ-606")).toMatchObject({
      status: "candidate_done_external_gate",
      remaining: [
        "authorize-public-source-launch",
        "rerun-from-first-published-release",
        "record-independent-unbriefed-human-session",
      ],
      evidence: ["TQ-606_PUBLIC_ADOPTION.md", "TQ-606_ADOPTION_CERTIFICATION.json"],
    });
  });

  test("preserves the authority, clock and product boundaries", () => {
    for (const invariant of [
      "core_remains_profile_and_provider_neutral",
      "runtime_success_never_implicitly_completes_a_commitment",
      "authority_time_is_explicit_or_clock_injected",
      "device_clock_is_read_only_by_systemClock_composition",
      "local_console_remains_loopback_and_read_only",
      "remote_surfaces_require_adr_004_guard",
      "public_launch_requires_private_multi_app_dogfood",
      "published_claims_require_external_evidence",
    ]) {
      expect(roadmap.invariants).toContain(invariant);
    }
    expect(roadmap.decisions).toContainEqual({
      id: "ADR-005",
      status: "pending",
      blocks: ["TQ-906"],
      question: "Evidence trust, authenticity, supersession, revocation and retention",
    });
  });

  test("makes dogfood a time-bounded three-consumer product gate, not prose", () => {
    expect(dogfood).toMatchObject({
      contractVersion: "tasq.private-dogfood.v1",
      status: "program-open-evidence-pending",
      startedAt: "2026-07-22",
      minimumCalendarDays: 30,
      earliestDecisionAt: "2026-08-21",
      currentPhase: "baseline_and_activation",
      nextAction:
        "Record the exact candidate version and commit, then verify the first isolated backup and attach its evidence.",
      publicLaunchDecision: "undecided",
      tq607Complete: false,
    });
    expect(dogfood.phases).toEqual([
      { id: "baseline_and_activation", state: "in_progress" },
      { id: "first_complete_journeys", state: "pending" },
      { id: "repeated_operation", state: "pending" },
      { id: "resilience_drills", state: "pending" },
      { id: "decision_review", state: "blocked_until_2026-08-21" },
    ]);
    expect(dogfood.consumers.map(({ id }) => id)).toEqual([
      "personal-life-pilot",
      "kami-robotics",
      "interactive-agent-runtime",
    ]);
    for (const consumer of dogfood.consumers) {
      expect(consumer.state, consumer.id).toBe("not_started");
      expect(consumer.evidence, consumer.id).toEqual([]);
    }
    expect(dogfood.crossCuttingEvidence).toMatchObject({
      requiredForwardUpgradeDrills: 2,
      completedForwardUpgradeDrills: 0,
      backupRestoreCompleted: false,
      replacementActorRecoveryCompleted: false,
      coldAgentOnboardingCompleted: false,
      supportBundleReviewCompleted: false,
    });
    expect(dogfood.frictionLog).toEqual([]);
    expect(dogfood.unresolvedCriticalFailures).toEqual([]);
  });
});
