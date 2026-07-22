import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const markdown = readFileSync(resolve(root, "BACKLOG.md"), "utf8");
const roadmap = JSON.parse(readFileSync(resolve(root, "BACKLOG.json"), "utf8")) as {
  contractVersion: string;
  revision: number;
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
  revision: number;
  status: string;
  startedAt: string;
  minimumCalendarDays: number;
  earliestDecisionAt: string;
  baseline: {
    candidateVersion: string;
    sourceCommit: string;
  };
  currentPhase: string;
  nextAction: string;
  phases: Array<{ id: string; state: string }>;
  consumers: Array<{
    id: string;
    state: string;
    recordedActiveUseDays?: number;
    completedJourneys: Array<{ id: string }>;
    evidence: unknown[];
  }>;
  crossCuttingEvidence: Record<string, unknown>;
  frictionLog: Array<{ id: string }>;
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
      repositoryVisibility: "public_alpha",
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
      status: "candidate_done_publication_gate",
      milestone: "runtime-consumers",
      dependsOn: ["TQ-603", "TQ-304", "TQ-501"],
      remaining: ["rerun-from-first-published-release"],
      evidence: [
        "TQ-320_INTERACTIVE_RUNTIME_CONSUMER.md",
        "TQ-320_INTERACTIVE_RUNTIME_CERTIFICATION.json",
      ],
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
        state: "complete_public_alpha",
      },
      npmScopeControl: {
        state: "unverified",
        observation: expect.stringContaining("not evidence of scope ownership"),
      },
      npmTrustedPublishing: { state: "unverified" },
      firstProtectedRelease: { state: "not_run" },
      publishedLifecycleCertification: { state: "blocked_by_first_protected_release" },
      publishedAdoptionCertification: { state: "blocked_by_first_protected_release" },
      publishedInteractiveRuntimeCertification: { state: "blocked_by_first_protected_release" },
      independentBlindHumanAdoption: { state: "not_run" },
    });
    expect(roadmap.items.find(({ id }) => id === "TQ-321")).toMatchObject({
      status: "pending",
      milestone: "runtime-consumers",
    });
    expect(roadmap.items.find(({ id }) => id === "TQ-608")).toMatchObject({
      status: "pending",
      milestone: "public-distribution",
    });
    expect(roadmap.items.find(({ id }) => id === "TQ-607")).toMatchObject({
      id: "TQ-607",
      status: "in_progress_dogfood",
      milestone: "private-dogfood",
      dependsOn: ["TQ-304", "TQ-501", "TQ-504"],
      remaining: [
        "complete-19-more-personal-active-use-days",
        "complete-personal-open-blocked-resumed-evidence-journey",
        "complete-personal-no-direct-store-repair-journey",
        "complete-second-live-ledger-upgrade",
        "complete-minimum-duration",
        "record-go-extend-or-no-go-decision",
      ],
      evidence: [
        "TQ-607_PRIVATE_DOGFOOD_GATE.md",
        "TQ-607_DOGFOOD_STATUS.json",
        "evidence/tq-607/README.md",
      ],
    });
    expect(roadmap.items.find(({ id }) => id === "TQ-603")).toMatchObject({
      id: "TQ-603",
      status: "pending",
      dependsOn: ["TQ-321", "TQ-608", "TQ-607"],
      remaining: [
        "complete-agent-integration-certification",
        "complete-migration-hardening",
        "verify-npm-scope-control",
        "configure-npm-trusted-publishing",
        "publish-first-protected-release",
      ],
    });
    expect(roadmap.items.find(({ id }) => id === "TQ-604")).toMatchObject({
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
      "stable_package_release_requires_operational_hardening_and_external_evidence",
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
      currentPhase: "repeated_operation",
      publicLaunchDecision: "undecided",
      tq607Complete: false,
    });
    expect(dogfood.revision).toBeGreaterThan(1);
    expect(dogfood.baseline).toMatchObject({
      candidateVersion: "0.1.0-private.1",
      sourceCommit: "8763e4e60159c2b7de5c2454e3b472492e85d8e9",
    });
    expect(dogfood.phases).toEqual([
      { id: "baseline_and_activation", state: "complete" },
      { id: "first_complete_journeys", state: "complete" },
      { id: "repeated_operation", state: "in_progress" },
      { id: "resilience_drills", state: "pending" },
      { id: "decision_review", state: "blocked_until_2026-08-21" },
    ]);
    expect(dogfood.consumers.map(({ id }) => id)).toEqual([
      "personal-life-pilot",
      "kami-robotics",
      "interactive-agent-runtime",
    ]);
    expect(dogfood.consumers.map(({ id, state }) => ({ id, state }))).toEqual([
      { id: "personal-life-pilot", state: "in_progress" },
      { id: "kami-robotics", state: "complete" },
      { id: "interactive-agent-runtime", state: "complete" },
    ]);
    expect(dogfood.consumers[0].recordedActiveUseDays).toBe(1);
    expect(dogfood.consumers[0].completedJourneys).toHaveLength(1);
    expect(dogfood.consumers[1].completedJourneys).toHaveLength(4);
    expect(dogfood.consumers[2].completedJourneys).toHaveLength(4);
    expect(dogfood.crossCuttingEvidence).toMatchObject({
      requiredForwardUpgradeDrills: 2,
      completedForwardUpgradeDrills: 1,
      backupRestoreCompleted: true,
      replacementActorRecoveryCompleted: true,
      coldAgentOnboardingCompleted: true,
      supportBundleReviewCompleted: true,
    });
    expect(dogfood.frictionLog.map(({ id }) => id)).toEqual(["TQ607-FR-001", "TQ607-FR-002"]);
    expect(dogfood.unresolvedCriticalFailures).toEqual([]);
  });
});
