/** ADR-004 / TQ-505 — machine guard for the accepted hosted-tenancy design. */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const product = resolve(import.meta.dir, "../..");
const acceptance = JSON.parse(readFileSync(
  resolve(product, "HOSTED_TENANCY_ACCEPTANCE.json"),
  "utf8",
)) as {
  contractVersion: string;
  status: string;
  decision: string;
  criticalFailuresAreNonCompensable: boolean;
  layers: string[];
  identityMethods: Array<{ id: string; subjects: string[]; requiredClaims: string[] }>;
  surfaces: Array<{ id: string; status: string; sharedGuard: boolean }>;
  dimensions: Record<string, string[]>;
  scenarios: Array<{
    id: string;
    principles: string[];
    surfaces: string[];
    requiredOutcome: string;
  }>;
  criticalFailures: string[];
  releaseRequirements: {
    platforms: string[];
    minimumIssuers: number;
    minimumConsecutiveBlindPassesPerFamilyAndScenario: number;
    humanInterventionsDuringAutonomousTrials: number;
    requiredClients: string[];
    requiredEvidence: string[];
  };
};

describe("ADR-004 hosted-tenancy design guard", () => {
  test("separates every trust layer and keeps remote surfaces honestly planned", () => {
    expect(acceptance).toMatchObject({
      contractVersion: "tasq.hosted-tenancy-acceptance.v1",
      status: "host-integrated-read-rest-implemented-no-deployable-server",
      decision: "ADR-004_AUTHENTICATED_HOSTED_TENANCY.md",
      criticalFailuresAreNonCompensable: true,
    });
    expect(acceptance.layers).toEqual([
      "transport", "authentication", "subject_binding", "authorization",
      "kernel", "effect_gate",
    ]);
    expect(acceptance.surfaces.map(({ id, status }) => [id, status])).toEqual([
      ["rest", "implemented_integration_required_read_only"],
      ["remote_mcp", "planned"],
      ["hosted_web_bff", "planned"],
      ["local_cli_stdio_loopback", "implemented_local_only"],
    ]);
    for (const surface of acceptance.surfaces.filter(({ status }) => status !== "implemented_local_only")) {
      expect(surface.sharedGuard).toBe(true);
    }
  });

  test("covers human, delegated-agent and workload identity without accepting identity as permission", () => {
    expect(acceptance.identityMethods.map(({ id }) => id)).toEqual([
      "oidc_oauth_access_token", "oauth_introspection", "spiffe_workload",
    ]);
    for (const method of acceptance.identityMethods) {
      expect(method.requiredClaims).toContain("issuer");
      expect(method.requiredClaims).toContain("subject");
      expect(method.requiredClaims).toContain("audience");
      expect(method.requiredClaims).toContain("expires_at");
    }
    expect(acceptance.releaseRequirements.requiredClients).toEqual([
      "browser_human", "headless_human_delegated_agent", "workload_agent",
    ]);
    expect(acceptance.releaseRequirements.minimumIssuers).toBeGreaterThanOrEqual(2);
  });

  test("makes every first-principles hostile boundary a named scenario", () => {
    const scenarioIds = acceptance.scenarios.map(({ id }) => id);
    expect(new Set(scenarioIds).size).toBe(scenarioIds.length);
    for (const required of [
      "protected_resource_discovery_no_data",
      "issuer_subject_collision",
      "cross_workspace_read_probe",
      "revoked_grant_unexpired_token",
      "delegated_agent_intersection",
      "surface_switch_no_widening",
      "privileged_token_replay",
      "unknown_key_rotation",
      "concurrent_revocation_and_mutation",
      "effect_separation_of_duty",
      "headless_device_authorization",
      "workload_attestation_rotation",
      "replica_revocation",
      "injected_clock_matrix",
      "lost_response_retry",
    ]) {
      expect(scenarioIds, `missing hosted scenario ${required}`).toContain(required);
    }
    const surfaces = new Set(acceptance.surfaces.map(({ id }) => id));
    for (const scenario of acceptance.scenarios) {
      expect(scenario.principles.length).toBeGreaterThan(0);
      expect(scenario.requiredOutcome.length).toBeGreaterThan(20);
      for (const surface of scenario.surfaces) expect(surfaces.has(surface)).toBe(true);
    }
  });

  test("keeps safety failures non-compensable and release evidence state-based", () => {
    expect(acceptance.criticalFailures).toEqual([
      "cross_workspace_disclosure",
      "unauthenticated_mutation",
      "authority_widening",
      "subject_actor_conflation",
      "token_scope_used_without_live_grant",
      "effect_dispatch_without_exact_gate",
      "credential_or_secret_logged",
      "device_clock_authority",
      "remote_route_bypasses_guard",
      "revoked_replica_reactivated",
    ]);
    expect(acceptance.releaseRequirements).toMatchObject({
      platforms: ["linux", "macos"],
      minimumConsecutiveBlindPassesPerFamilyAndScenario: 3,
      humanInterventionsDuringAutonomousTrials: 0,
    });
    expect(acceptance.releaseRequirements.requiredEvidence).toEqual([
      "transport_transcript", "authorization_decisions", "ledger_state",
      "provider_invocation_count", "clock_trace",
    ]);
    for (const values of Object.values(acceptance.dimensions)) {
      expect(values.length).toBeGreaterThan(1);
    }
  });
});
