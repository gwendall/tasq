/** TQ-601 — executable guard for the product and consumption contract. */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const product = resolve(import.meta.dir, "../..");
const matrix = JSON.parse(readFileSync(
  resolve(product, "PRODUCT_SURFACE_MATRIX.json"),
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
      publiclyDistributed: false,
    });
    expect(byId(matrix.productShapes, "local")).toMatchObject({
      support: "implemented_certified",
      publiclyDistributed: false,
    });
    expect(byId(matrix.productShapes, "server")).toMatchObject({
      support: "not_implemented",
      entrypoints: [],
    });
    expect(byId(matrix.productShapes, "cloud")).toMatchObject({
      support: "accepted_design_not_executed",
      entrypoints: [],
    });
  });

  test("classifies every surface with a closed support vocabulary", () => {
    expect(matrix.supportLevels).toEqual([
      "implemented_certified",
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
    for (const id of ["rest", "remote_mcp", "hosted_console"]) {
      expect(byId(matrix.surfaces, id)).toMatchObject({
        support: "not_implemented",
        entrypoint: null,
        mutations: false,
      });
    }
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
    expect(byId(matrix.consumers, "remote_agent")).toMatchObject({
      supportedSurfaces: [],
      irreducibleInputs: ["hosted_authenticated_transport"],
    });
    expect(byId(matrix.consumers, "self_host_operator")).toMatchObject({
      supportedSurfaces: [],
      irreducibleInputs: ["tasq_server_release"],
    });
  });

  test("keeps install, self-host and remote journeys honestly unimplemented", () => {
    expect(byId(matrix.journeys, "local_agent_from_executable").support)
      .toBe("implemented_certified");
    for (const id of [
      "public_install_to_first_agent",
      "remote_multi_user_collaboration",
      "self_host_lifecycle",
    ]) {
      expect(byId(matrix.journeys, id).support).toBe("not_implemented");
    }
  });

  test("locks the first-principles onboarding, authority and clock truths", () => {
    for (const truth of [
      "tasq_is_not_only_a_cli",
      "from_scratch_starts_after_executable_or_transport_handoff",
      "same_workspace_text_does_not_bridge_isolated_stores",
      "mcp_is_local_stdio_not_remote",
      "local_console_is_read_only_not_an_agent_api",
      "rest_is_not_implemented",
      "self_hosted_server_is_not_implemented",
      "hosted_design_is_not_hosted_behavior",
      "all_public_packages_are_currently_private",
      "device_time_is_only_read_by_the_system_clock_adapter",
    ]) {
      expect(matrix.criticalTruths, `missing critical truth: ${truth}`).toContain(truth);
    }
  });
});
