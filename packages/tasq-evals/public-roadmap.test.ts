import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const markdown = readFileSync(resolve(root, "docs/roadmap/BACKLOG.md"), "utf8");
const releaseWorkflow = readFileSync(resolve(root, ".github/workflows/release.yml"), "utf8");
const npmBootstrap = JSON.parse(readFileSync(
  resolve(root, "docs/contracts/TQ-603_NPM_BOOTSTRAP_CERTIFICATION.json"),
  "utf8",
)) as {
  contractVersion: string;
  status: string;
  repository: string;
  sourceCommit: string;
  bootstrap: {
    version: string;
    distTag: string;
    publishedSupportGranted: boolean;
    githubEnvironmentSecretDeleted: boolean;
    granularAccessTokenRevoked: boolean;
  };
  trustedPublisher: {
    repository: string;
    workflowFile: string;
    environment: string;
    permissions: string[];
  };
  packages: Array<{
    name: string;
    version: string;
    gitHead: string;
    integrity: string;
    tarball: string;
    trustId: string;
  }>;
};
const releaseCertification = JSON.parse(readFileSync(
  resolve(root, "docs/contracts/TQ-603_RELEASE_CERTIFICATION.json"),
  "utf8",
)) as {
  contractVersion: string;
  status: string;
  version: string;
  tag: string;
  sourceCommit: string;
  workflow: {
    runId: number;
    identityJob: string;
    nativeBuildJobs: Record<string, string>;
    npmTrustedPublishingJob: string;
    githubReleaseJob: { initialState: string; recovery: string };
  };
  githubRelease: { url: string; targetCommit: string; prerelease: boolean; assetCount: number };
  npm: {
    distTag: string;
    trustedPublishing: string;
    packages: Array<{ name: string; version: string; integrity: string }>;
  };
  security: Record<string, boolean>;
};
const roadmap = JSON.parse(readFileSync(resolve(root, "docs/roadmap/BACKLOG.json"), "utf8")) as {
  contractVersion: string;
  revision: number;
  status: string;
  canonicalRepository: string;
  repositoryVisibility: string;
  statusVocabulary: string[];
  invariants: string[];
  externalGates: Record<string, { state: string; observation?: string; [key: string]: unknown }>;
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
  resolve(root, "docs/contracts/TQ-607_DOGFOOD_STATUS.json"),
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
        "in_progress_implementation",
        "in_progress_dogfood",
        "in_progress_external_gate",
        "candidate_done_publication_gate",
        "candidate_done_external_gate",
        "pending_independent_review",
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
      evidence: ["docs/contracts/TQ-801_HOSTED_AUTHORITY_FOUNDATION.md", "docs/contracts/TQ-801_AUTHORITY_CERTIFICATION.json"],
    });
    expect(roadmap.items.find(({ id }) => id === "TQ-802")).toMatchObject({
      status: "done",
      evidence: ["docs/contracts/TQ-802_AUTHORITY_STORE_ROUTER.md", "docs/contracts/TQ-802_AUTHORITY_STORE_CERTIFICATION.json"],
    });
    expect(roadmap.items.find(({ id }) => id === "TQ-803")).toMatchObject({
      status: "done",
      evidence: ["docs/contracts/TQ-803_HOSTED_READ_REST.md", "docs/contracts/TQ-803_READ_REST_CERTIFICATION.json"],
    });
    expect(roadmap.items.find(({ id }) => id === "TQ-804")).toMatchObject({
      status: "done",
      evidence: ["docs/contracts/TQ-804_GUARDED_MUTATION_REST.md", "docs/contracts/TQ-804_MUTATION_REST_CERTIFICATION.json"],
    });
    expect(roadmap.items.find(({ id }) => id === "TQ-809")).toMatchObject({
      status: "done",
      evidence: [
        "docs/decisions/ADR-010_REMOTE_CLIENT_AND_ENROLLMENT_BOUNDARY.md",
        "docs/contracts/TQ-809_REMOTE_CLIENT_AND_ENROLLMENT.md",
        "docs/contracts/TQ-809_REMOTE_CLIENT_CERTIFICATION.json",
        "packages/tasq-evals/remote-client-enrollment.test.ts",
      ],
    });
    expect(roadmap.items.find(({ id }) => id === "TQ-807")).toMatchObject({
      status: "in_progress_external_gate",
      remaining: ["publish_immutable_multi_arch_image_sbom_checksums_and_provenance"],
      evidence: [
        "docs/contracts/TQ-807_DEPLOYABLE_SERVER.md",
        "docs/contracts/TQ-807_SERVER_CERTIFICATION.json",
        "deploy/server/README.md",
      ],
    });
    expect(roadmap.items.find(({ id }) => id === "TQ-808")).toMatchObject({
      status: "candidate_done_external_gate",
      remaining: [
        "protected_multi_arch_image_and_provenance",
        "macos_and_linux_clients_against_exact_published_digest",
        "previously_unbriefed_operator_deployment",
      ],
    });
    expect(roadmap.items.find(({ id }) => id === "TQ-320")).toMatchObject({
      status: "done",
      milestone: "runtime-consumers",
      dependsOn: ["TQ-603", "TQ-304", "TQ-501"],
      remaining: [],
      evidence: [
        "docs/contracts/TQ-320_INTERACTIVE_RUNTIME_CONSUMER.md",
        "docs/contracts/TQ-320_INTERACTIVE_RUNTIME_CERTIFICATION.json",
      ],
    });
    expect(roadmap.items.find(({ id }) => id === "TQ-618")).toMatchObject({
      status: "candidate_done_publication_gate",
      remaining: ["publish_exact_implementation_in_authorized_v0.4.0_artifacts"],
      evidence: [
        "docs/contracts/TQ-618_ATTEMPT_COST_BOUNDS.md",
        "docs/contracts/TQ-618_ATTEMPT_COST_BOUNDS.json",
        "packages/tasq-core/test/costs.test.ts",
        "packages/tasq-cli/test/cost.test.ts",
      ],
    });
    expect(roadmap.items.find(({ id }) => id === "TQ-619")).toMatchObject({
      status: "candidate_done_publication_gate",
      remaining: ["publish_exact_implementation_in_authorized_v0.4.0_artifacts"],
      evidence: [
        "docs/contracts/TQ-619_REFUTABLE_TASK_PREMISES.md",
        "docs/contracts/TQ-619_REFUTABLE_TASK_PREMISES.json",
        "packages/tasq-service/test/premises.test.ts",
        "packages/tasq-cli/test/premise.test.ts",
      ],
    });
    for (const id of ["TQ-806", "TQ-810", "TQ-901", "TQ-902", "TQ-903", "TQ-904", "TQ-905"]) {
      const item = roadmap.items.find((candidate) => candidate.id === id);
      expect(item?.status, `${id}: source candidate status`).toBe(
        "candidate_done_external_gate",
      );
      expect(item?.remaining?.length, `${id}: external gate must remain explicit`)
        .toBeGreaterThan(0);
    }
    expect(roadmap.items.find(({ id }) => id === "TQ-906")).toMatchObject({
      status: "pending_independent_review",
      remaining: [
        "published_artifact_signed_statement_certification",
        "exact_deployed_connector_permit_receipt_chain",
        "live_revocation_and_compromise_races",
        "independent_evidence_and_authority_review",
        "protected_deployment_rollback_and_incident_drill",
      ],
    });
  });

  test("states the real publication blockers without inventing ownership", () => {
    expect(roadmap.externalGates).toMatchObject({
      privateMultiAppDogfood: {
        state: "in_progress",
        blocks: "stable_graduation",
        publicAlphaBlocking: false,
      },
      maintainerPublicAlphaAuthorization: { state: "complete_for_v0_4_0_public_alpha" },
      publicSourceLaunch: {
        state: "complete_public_alpha",
      },
      npmScopeControl: {
        state: "verified",
        organization: "tasq-run",
        operator: "gwendall",
        boundary: expect.stringContaining("eight package identities"),
      },
      npmTrustedPublishing: {
        state: "verified",
        packageCount: 8,
        evidence: expect.arrayContaining([
          "docs/contracts/TQ-603_NPM_BOOTSTRAP_CERTIFICATION.json",
        ]),
      },
      npmClientDefaultTag: {
        state: "external_remediation_required",
        coordinate: "@tasq-run/client",
        blocks: "any_default_install_claim_until_an_exact_supported_release_replaces_or_removes_the_tag",
      },
      firstProtectedRelease: {
        state: "complete",
        channel: "public_alpha",
        version: "0.1.0",
        sourceCommit: "0f5357ea10e0eb9f86f143a4fc38030624238bd2",
      },
      publishedLifecycleCertification: { state: "complete" },
      publishedConsoleLifecycleCertification: { state: "complete" },
      publishedAdoptionCertification: { state: "automated_complete_human_pending" },
      publishedInteractiveRuntimeCertification: { state: "complete" },
      independentBlindHumanAdoption: { state: "not_run" },
    });
    expect(roadmap.items.find(({ id }) => id === "TQ-321")).toMatchObject({
      status: "done",
      milestone: "runtime-consumers",
      remaining: [],
      evidence: [
        "docs/contracts/TQ-321_ZERO_CONTEXT_AGENT_INTEGRATION.md",
        "docs/contracts/TQ-321_AGENT_PLUGIN_CERTIFICATION.json",
        "evidence/tq-321/latest.json",
        "docs/integrations/AGENT_INTEGRATIONS.md",
        "docs/integrations/AGENT_INTEGRATIONS.json",
        "plugins/tasq/skills/tasq/SKILL.md",
      ],
    });
    expect(roadmap.items.find(({ id }) => id === "TQ-608")).toMatchObject({
      status: "candidate_done_external_gate",
      milestone: "public-distribution",
      remaining: [
        "replay-exact-published-v0.4.0-bytes-after-publication",
      ],
      evidence: expect.arrayContaining([
        "docs/contracts/TQ-608_MIGRATION_CERTIFICATION.json",
        "packages/tasq-service/test/data-safety.test.ts",
      ]),
    });
    expect(roadmap.items.find(({ id }) => id === "TQ-633")).toMatchObject({
      status: "candidate_done_external_gate",
      milestone: "public-distribution",
      dependsOn: ["TQ-603"],
      remaining: ["remove_or_replace_bootstrap_latest_dist_tag_on_npm_registry"],
      evidence: [
        "docs/contracts/TQ-633_NPM_DEFAULT_TAG_SAFETY.md",
        "docs/contracts/TQ-633_NPM_DEFAULT_TAG_SAFETY.json",
        ".github/workflows/bootstrap-npm-client.yml",
        ".github/workflows/release.yml",
        "packages/tasq-evals/npm-bootstrap.test.ts",
      ],
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
        "docs/contracts/TQ-607_PRIVATE_DOGFOOD_GATE.md",
        "docs/contracts/TQ-607_DOGFOOD_STATUS.json",
        "evidence/tq-607/README.md",
      ],
    });
    expect(roadmap.items.find(({ id }) => id === "TQ-603")).toMatchObject({
      id: "TQ-603",
      status: "done",
      dependsOn: ["TQ-321", "TQ-608"],
      evidence: [
        "docs/contracts/TQ-603_NPM_BOOTSTRAP_CERTIFICATION.json",
        "docs/contracts/TQ-603_RELEASE_CERTIFICATION.json",
        "https://github.com/gwendall/tasq/releases/tag/v0.3.0",
      ],
    });
    expect(roadmap.items.find(({ id }) => id === "TQ-604")).toMatchObject({
      id: "TQ-604",
      status: "done",
      remaining: [],
      evidence: [
        "docs/contracts/TQ-604_LIFECYCLE_CERTIFICATION.json",
        "https://github.com/gwendall/tasq/actions/runs/30051196124",
      ],
    });
    expect(roadmap.items.find(({ id }) => id === "TQ-605")).toMatchObject({
      status: "done",
      evidence: ["docs/contracts/TQ-605_PUBLIC_SITE.md"],
    });
    expect(roadmap.items.find(({ id }) => id === "TQ-606")).toMatchObject({
      status: "candidate_done_external_gate",
      remaining: [
        "record-independent-unbriefed-human-session",
      ],
      evidence: [
        "docs/contracts/TQ-606_PUBLIC_ADOPTION.md",
        "docs/contracts/TQ-606_ADOPTION_CERTIFICATION.json",
        "docs/contracts/TQ-606_HUMAN_SESSION_PROTOCOL.md",
        "docs/contracts/TQ-606_HUMAN_SESSION_EVIDENCE.schema.json",
      ],
    });
    expect(roadmap.items.find(({ id }) => id === "TQ-620")).toMatchObject({
      status: "done",
      milestone: "autonomous-direction",
      dependsOn: ["TQ-813"],
      remaining: [],
      evidence: [
        "docs/contracts/TQ-620_BOUNDED_ATTENTION.md",
        "docs/contracts/TQ-620_BOUNDED_ATTENTION.json",
        "packages/tasq-webhook-notifier/test/bounded-attention.test.ts",
        "packages/tasq-service/test/delivery.test.ts",
      ],
    });
    expect(releaseWorkflow).toContain("id-token: write");
    expect(releaseWorkflow).toContain("npm install --global npm@11.18.0");
    expect(releaseWorkflow).toContain('test "$(npm --version)" = "11.18.0"');
    expect(releaseWorkflow).toContain("verify-release-authorization.ts");
    expect(releaseWorkflow).not.toContain("NODE_AUTH_TOKEN");
  });

  test("binds the completed one-shot npm bootstrap to seven registry identities and no retained token", () => {
    expect(npmBootstrap).toMatchObject({
      contractVersion: "tasq.npm-bootstrap-certification.v1",
      status: "passed",
      repository: "gwendall/tasq",
      sourceCommit: "9fac010407fe3125319bd9bce067ef9d5448bb95",
      bootstrap: {
        version: "0.1.0-alpha.0",
        distTag: "alpha-bootstrap",
        publishedSupportGranted: false,
        githubEnvironmentSecretDeleted: true,
        granularAccessTokenRevoked: true,
      },
      trustedPublisher: {
        repository: "gwendall/tasq",
        workflowFile: "release.yml",
        environment: "release",
        permissions: ["publish"],
      },
    });
    expect(npmBootstrap.packages.map(({ name }) => name)).toEqual([
      "@tasq-run/schema",
      "@tasq-run/core",
      "@tasq-run/cli",
      "@tasq-run/mcp",
      "@tasq-run/extension-sdk",
      "@tasq-run/protocol-adapters",
      "@tasq-run/console",
    ]);
    for (const entry of npmBootstrap.packages) {
      expect(entry.version).toBe("0.1.0-alpha.0");
      expect(entry.gitHead).toBe("9fac010407fe3125319bd9bce067ef9d5448bb95");
      expect(entry.integrity).toMatch(/^sha512-/);
      expect(entry.tarball).toContain("https://registry.npmjs.org/@tasq-run/");
      expect(entry.trustId).toMatch(/^[a-f0-9-]{36}$/);
    }
  });

  test("binds the current supported alpha to protected package and native release evidence", () => {
    expect(releaseCertification).toMatchObject({
      contractVersion: "tasq.public-release-certification.v1",
      status: "published",
      version: "0.3.0",
      tag: "v0.3.0",
      sourceCommit: "c093ed58ab2a9e38dbd9d877ba75021997761057",
      workflow: {
        runId: 30050429924,
        identityJob: "passed",
        nativeBuildJobs: { "darwin-arm64": "passed", "linux-x64-gnu": "passed" },
        npmTrustedPublishingJob: "passed",
        githubReleaseJob: "passed",
      },
      githubRelease: {
        url: "https://github.com/gwendall/tasq/releases/tag/v0.3.0",
        targetCommit: "c093ed58ab2a9e38dbd9d877ba75021997761057",
        prerelease: false,
        assetCount: 10,
      },
      npm: {
        distTag: "latest",
        trustedPublishing: "oidc-with-provenance",
      },
      security: {
        npmAutomationTokenUsedForSupportedRelease: false,
        maintainerWorkstationBuildArtifactsPublished: false,
        releaseAssetsUploadedFromAttestedWorkflowArtifacts: true,
        immutableTagVerified: true,
      },
    });
    expect(releaseCertification.npm.packages).toHaveLength(7);
    for (const entry of releaseCertification.npm.packages) {
      expect(entry.version).toBe("0.3.0");
      expect(entry.integrity).toMatch(/^sha512-/);
    }
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
      status: "accepted",
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
