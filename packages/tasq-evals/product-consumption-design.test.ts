/** TQ-601 — executable guard for the product and consumption contract. */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const product = resolve(import.meta.dir, "../..");
const matrix = JSON.parse(readFileSync(
  resolve(product, "docs/concepts/PRODUCT_SURFACE_MATRIX.json"),
  "utf8",
)) as {
  contractVersion: string;
  status: string;
  supportLevels: string[];
  productShapes: Array<{
    id: string;
    support: string;
    entrypoints: string[];
    consumers: string[];
    publiclyDistributed: boolean;
  }>;
  surfaces: Array<{
    id: string;
    support: string;
    transport: string;
    entrypoint: string | null;
    mutations: boolean;
    authorityBoundary: string;
  }>;
  consumers: Array<{
    id: string;
    supportedSurfaces: string[];
    irreducibleInputs: string[];
  }>;
  journeys: Array<{ id: string; support: string; steps: string[] }>;
  criticalTruths: string[];
};
const releasePolicy = JSON.parse(readFileSync(
  resolve(product, "docs/releases/PUBLIC_RELEASE_POLICY.json"),
  "utf8",
)) as {
  status: string;
  identity: {
    repositoryState: string;
    npmScope: string;
    unavailableNpmScope: {
      name: string;
      ownership: string;
      mustNeverPublish: boolean;
    };
  };
  externalPublicationGateStatus: Record<string, boolean>;
  releaseAuthorization: {
    state: string;
    version: string;
    channel: string;
    decision: string;
    authorizedBy: string;
  };
  publishedRelease: null | Record<string, unknown>;
  repositoryControls: {
    requiredPullRequest: boolean;
    requiredChecks: string[];
    releaseTagsMutable: boolean;
    releaseEnvironment: string;
    privateVulnerabilityReporting: boolean;
  };
};
const lifecycle = JSON.parse(readFileSync(
  resolve(product, "docs/contracts/TQ-604_LIFECYCLE_CERTIFICATION.json"),
  "utf8",
)) as {
  contractVersion: string;
  status: string;
  supportedTargets: string[];
  installation: Record<string, unknown>;
  data: Record<string, unknown>;
  authority: Record<string, unknown>;
  candidateEvidence: { requiredCiTargets: string[]; journey: string[] };
  publishedArtifactEvidence: { status: string };
  tq604Complete: boolean;
};

function byId<T extends { id: string }>(items: T[], id: string): T {
  const item = items.find((candidate) => candidate.id === id);
  if (!item) throw new Error(`missing product contract item: ${id}`);
  return item;
}

describe("TQ-601 product consumption design", () => {
  test("freezes four shapes without turning roadmap into implementation", () => {
    expect(matrix).toMatchObject({
      contractVersion: "tasq.product-surface-matrix.v1",
      status: "accepted-product-contract",
    });
    expect(matrix.productShapes.map(({ id }) => id)).toEqual([
      "core", "local", "server", "cloud",
    ]);
    expect(byId(matrix.productShapes, "core")).toMatchObject({
      support: "implemented_integration_required",
      publiclyDistributed: true,
    });
    expect(byId(matrix.productShapes, "local")).toMatchObject({
      support: "implemented_certified",
      publiclyDistributed: true,
    });
    expect(byId(matrix.productShapes, "server")).toMatchObject({
      support: "implemented_candidate_not_published",
      publiclyDistributed: false,
    });
    expect(byId(matrix.productShapes, "cloud")).toMatchObject({
      support: "implemented_candidate_not_published",
      entrypoints: ["cloud_control_plane", "cloud_bff"],
      publiclyDistributed: false,
    });
  });

  test("classifies every surface with a closed support vocabulary", () => {
    expect(matrix.supportLevels).toEqual([
      "implemented_certified",
      "implemented_candidate_not_published",
      "implemented_local_only",
      "implemented_integration_required",
      "reference_only",
      "accepted_design_not_executed",
      "not_implemented",
      "impossible_without_transport",
    ]);
    const levels = new Set(matrix.supportLevels);
    for (const surface of matrix.surfaces) {
      expect(levels.has(surface.support), `${surface.id}: unknown support`).toBe(true);
      expect(surface.transport.length).toBeGreaterThan(0);
      expect(surface.authorityBoundary.length).toBeGreaterThan(0);
    }
    expect(byId(matrix.surfaces, "cli_json")).toMatchObject({
      support: "implemented_certified",
      mutations: true,
    });
    expect(byId(matrix.surfaces, "mcp_stdio")).toMatchObject({
      support: "implemented_local_only",
      transport: "stdio",
    });
    expect(byId(matrix.surfaces, "local_console")).toMatchObject({
      support: "implemented_local_only",
      mutations: false,
    });
    expect(byId(matrix.surfaces, "public_site")).toMatchObject({
      support: "implemented_certified",
      transport: "public_https_static_files",
      mutations: false,
      authorityBoundary: "versioned_repository_truth_no_ledger_access",
    });
    expect(byId(matrix.surfaces, "rest")).toMatchObject({
      support: "implemented_candidate_not_published",
      entrypoint: "Tasq Server /v1/workspaces/{workspace}/...",
      mutations: true,
    });
    expect(byId(matrix.surfaces, "remote_mcp")).toMatchObject({
      support: "implemented_candidate_not_published",
      entrypoint: "@tasq-internal/server createHostedMcpHandler",
      mutations: true,
    });
    expect(byId(matrix.surfaces, "remote_typescript")).toMatchObject({
      support: "implemented_candidate_not_published",
      entrypoint: "@tasq-run/client createRemoteTasq({ endpoint, workspaceId, accessToken })",
      mutations: true,
    });
    expect(byId(matrix.surfaces, "remote_cli")).toMatchObject({
      support: "implemented_candidate_not_published",
      mutations: true,
    });
    expect(byId(matrix.surfaces, "remote_enrollment")).toMatchObject({
      support: "implemented_candidate_not_published",
      mutations: true,
    });
    expect(byId(matrix.surfaces, "hosted_console")).toMatchObject({
      support: "implemented_candidate_not_published",
      entrypoint: "Tasq Server /console",
      mutations: true,
    });
    expect(byId(matrix.surfaces, "signed_statements")).toMatchObject({
      support: "implemented_candidate_not_published",
      mutations: true,
    });
    expect(byId(matrix.surfaces, "authenticated_offline_replication"))
      .toMatchObject({
        support: "implemented_candidate_not_published",
        mutations: true,
      });
    expect(byId(matrix.surfaces, "remote_python")).toMatchObject({
      support: "implemented_candidate_not_published",
      mutations: true,
    });
    expect(byId(matrix.surfaces, "cloud_bff")).toMatchObject({
      support: "implemented_candidate_not_published",
      mutations: true,
    });
  });

  test("gives every consumer a usable path or an explicit missing dependency", () => {
    const surfaceIds = new Set(matrix.surfaces.map(({ id }) => id));
    const consumerIds = new Set(matrix.consumers.map(({ id }) => id));
    for (const consumer of matrix.consumers) {
      expect(consumer.irreducibleInputs.length, consumer.id).toBeGreaterThan(0);
      for (const surface of consumer.supportedSurfaces) {
        expect(surfaceIds.has(surface), `${consumer.id}: ${surface}`).toBe(true);
      }
    }
    for (const shape of matrix.productShapes) {
      for (const consumer of shape.consumers) {
        expect(consumerIds.has(consumer), `${shape.id}: ${consumer}`).toBe(true);
      }
      for (const entrypoint of shape.entrypoints) {
        expect(surfaceIds.has(entrypoint), `${shape.id}: ${entrypoint}`).toBe(true);
      }
    }
    expect(byId(matrix.consumers, "extension_author").supportedSurfaces)
      .toContain("extension_sdk");
    expect(byId(matrix.consumers, "local_shell_agent")).toMatchObject({
      supportedSurfaces: ["cli_json"],
      irreducibleInputs: [
        "tasq_executable", "workspace_id", "actor_label", "capabilities", "task_intent",
      ],
    });
    expect(byId(matrix.consumers, "runtime_integrator")).toMatchObject({
      irreducibleInputs: [
        "runtime_identity_mapping",
        "stable_execution_id",
        "stable_context_id",
        "external_reference_mapping",
        "completion_authority_none",
        "store",
        "clock",
        "credential_verifier_for_rest",
      ],
    });
    expect(byId(matrix.consumers, "remote_agent")).toMatchObject({
      supportedSurfaces: [
        "remote_typescript",
        "remote_cli",
        "remote_mcp",
        "remote_python",
      ],
      irreducibleInputs: [
        "integrator_supplied_server_endpoint",
        "workspace_id",
        "one_use_enrollment_or_access_credential",
      ],
    });
    expect(byId(matrix.consumers, "self_host_operator")).toMatchObject({
      supportedSurfaces: ["server_daemon"],
      irreducibleInputs: [
        "tasq_server_candidate_image",
        "https_domain",
        "identity_issuer",
        "public_jwk",
        "durable_volume",
      ],
    });
    expect(byId(matrix.consumers, "prospective_adopter")).toMatchObject({
      supportedSurfaces: ["public_site"],
      irreducibleInputs: ["public_site_url_or_public_repository"],
    });
  });

  test("separates the certified candidate install from absent remote products", () => {
    expect(byId(matrix.journeys, "local_agent_from_executable").support)
      .toBe("implemented_certified");
    expect(byId(matrix.journeys, "public_install_to_first_agent").support)
      .toBe("implemented_certified");
    expect(byId(matrix.journeys, "public_product_discovery")).toMatchObject({
      support: "implemented_certified",
      steps: ["visit_public_site", "choose_consumer_path", "inspect_support_truth", "read_adoption_manifest", "install_release"],
    });
    expect(byId(matrix.journeys, "remote_multi_user_collaboration").support)
      .toBe("implemented_candidate_not_published");
    expect(byId(matrix.journeys, "self_host_lifecycle").support)
      .toBe("implemented_candidate_not_published");
    expect(byId(matrix.journeys, "managed_cloud_lifecycle").support)
      .toBe("implemented_candidate_not_published");
  });

  test("locks the first-principles onboarding, authority and clock truths", () => {
    for (const truth of [
      "tasq_is_not_only_a_cli",
      "from_scratch_starts_after_executable_or_transport_handoff",
      "same_workspace_text_does_not_bridge_isolated_stores",
      "published_mcp_is_local_stdio_while_remote_mcp_exists_only_as_an_unpublished_server_candidate",
      "local_console_is_read_only_not_an_agent_api",
      "deployable_server_source_and_local_container_candidate_exist_but_no_provenance_published_image_ships",
      "self_hosted_server_candidate_requires_operator_https_identity_and_durable_storage",
      "managed_cloud_source_candidate_is_not_a_deployed_or_available_managed_service",
      "canonical_source_repository_is_public_alpha",
      "public_package_bootstrap_identities_exist_under_a_non_default_prerelease_tag",
      "first_supported_public_alpha_release_is_published_with_oidc_provenance",
      "local_release_v0_1_0_is_published_and_multi_target_lifecycle_certified",
      "public_site_is_static_docs_not_console_or_agent_api",
      "public_site_is_deployed_at_tasq_run",
      "pre_executable_agent_adoption_is_machine_readable_and_fails_closed",
      "hosted_console_is_an_authenticated_guarded_bff_not_the_local_loopback_console",
      "server_effects_and_provider_connectors_are_disabled_and_absent_by_default",
      "signed_statement_source_candidate_authenticates_exact_bytes_and_principal_but_never_truth_completion_or_effect_authority",
      "authenticated_offline_replication_never_extends_live_claim_lease_approval_or_effect_authority",
      "python_remote_client_source_exists_but_is_not_published_to_pypi",
      "managed_cloud_remote_effects_are_unconditionally_disabled_pending_independent_review",
      "package_publication_requires_agent_integration_migration_hardening_maintainer_alpha_authorization_and_external_registry_control",
      "private_multi_app_dogfood_blocks_stable_graduation_not_labeled_public_alpha",
      "device_time_is_only_read_by_the_system_clock_adapter",
    ]) {
      expect(matrix.criticalTruths, `missing critical truth: ${truth}`).toContain(truth);
    }
  });

  test("binds public source to the immutable protected alpha", () => {
    expect(releasePolicy).toMatchObject({
      status: "published-alpha",
      identity: {
        repositoryState: "public-alpha-source",
        npmScope: "@tasq-run",
        unavailableNpmScope: {
          name: "@tasq",
          ownership: "unrelated-third-party",
          mustNeverPublish: true,
        },
      },
      repositoryControls: {
        enforcementState: "active-public-repository",
        requiredPullRequest: true,
        requiredChecks: ["verify (macos-14)", "verify (ubuntu-latest)"],
        desiredRequiredChecks: ["verify (macos-14)", "verify (ubuntu-latest)"],
        releaseTagsMutable: false,
        releaseEnvironment: "release",
        releaseEnvironmentTagPolicyVerified: true,
        privateVulnerabilityReporting: true,
      },
    });
    expect(releasePolicy.externalPublicationGateStatus).toMatchObject({
      maintainer_public_alpha_authorization: true,
      private_multi_app_dogfood_accepted: false,
      canonical_repository_control_verified: true,
      public_source_launch_authorized: true,
      npm_scope_control_verified: true,
      trusted_publishing_configured: true,
      tag_protection_configured: true,
    });
    expect(releasePolicy).toMatchObject({
      releaseAuthorization: {
        state: "authorized",
        version: "0.4.0",
        channel: "public-alpha",
        decision: "go",
        authorizedBy: "@gwendall",
      },
      publishedRelease: {
        version: "0.3.0",
        tag: "v0.3.0",
        sourceCommit: "c093ed58ab2a9e38dbd9d877ba75021997761057",
        githubRelease: "https://github.com/gwendall/tasq/releases/tag/v0.3.0",
      },
    });
    expect(byId(matrix.journeys, "public_install_to_first_agent").support)
      .toBe("implemented_certified");
  });

  test("binds lifecycle completion to the exact published certificate", () => {
    expect(lifecycle).toMatchObject({
      contractVersion: "tasq.lifecycle-certification.v1",
      status: "published-release-certified",
      supportedTargets: ["darwin-arm64", "linux-x64-gnu"],
      installation: {
        layout: "side-by-side-explicit-prefix",
        activation: "atomic-managed-symlink",
        shellStartupMutation: false,
      },
      data: {
        managedByInstaller: false,
        uninstallDisposition: "preserved-not-touched",
        downgradeInPlace: false,
      },
      authority: {
        listenerOnInstall: false,
        credentialReadOnInstall: false,
        deviceClockReadOnInstall: false,
      },
      candidateEvidence: {
        requiredCiTargets: ["verify (macos-14)", "verify (ubuntu-latest)"],
      },
      publishedArtifactEvidence: {
        status: "passed",
        workflowRun: "https://github.com/gwendall/tasq/actions/runs/30051196124",
      },
      tq604Complete: true,
    });
    for (const step of [
      "install-outside-checkout",
      "two-agent-contention-and-recovery",
      "inspect-same-ledger-through-console",
      "restore-snapshot-with-matching-binary",
      "uninstall-all-binaries-with-data-preserved",
    ]) {
      expect(lifecycle.candidateEvidence.journey).toContain(step);
    }
  });
});
