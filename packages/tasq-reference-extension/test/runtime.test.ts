import { describe, expect, test } from "bun:test";
import { ExtensionRuntimeRegistry } from "@tasq-run/extension-sdk";
import {
  HTTP_CONDITION_TYPE_URI,
  HTTP_OBSERVATION_TYPE_URI,
  MERCURY_CONDITION_TYPE_URI,
  REFERENCE_EXTENSION_MANIFEST,
  REFERENCE_EXTENSION_RUNTIME,
  WAIT_KIND_EXTENSION_IDENTITIES,
} from "../src/index.js";

const registry = new ExtensionRuntimeRegistry([REFERENCE_EXTENSION_RUNTIME]);

describe("bundled reference extension", () => {
  test("ships ten frozen types and five executable evaluators", () => {
    expect(REFERENCE_EXTENSION_MANIFEST.types).toHaveLength(10);
    expect(REFERENCE_EXTENSION_MANIFEST.evaluators).toHaveLength(5);
    expect(REFERENCE_EXTENSION_RUNTIME.conditions).toHaveLength(5);
    expect(REFERENCE_EXTENSION_RUNTIME.observations).toHaveLength(5);
    expect(REFERENCE_EXTENSION_RUNTIME.evaluators).toHaveLength(5);
  });

  test("keeps validator defaults and every historical HTTP method", () => {
    const httpCondition = registry.condition(HTTP_CONDITION_TYPE_URI, 1).parse({
      url: "https://example.com/hook",
      method: "POST",
      allowedStatuses: [200, 202],
    });
    expect(httpCondition.method).toBe("POST");
    const httpObservation = registry.observation(HTTP_OBSERVATION_TYPE_URI, 1).parse({
      url: "https://example.com/hook",
      method: "POST",
      statusCode: 202,
    });
    expect(httpObservation.bodyDigest).toBeNull();
    const httpSchema = REFERENCE_EXTENSION_MANIFEST.types.find((type) =>
      type.typeUri === HTTP_CONDITION_TYPE_URI)?.schema;
    expect(JSON.stringify(httpSchema)).toContain("POST");
  });

  test("keeps Mercury incoming/outgoing vocabulary and conditional identity validation", () => {
    const mercury = registry.condition(MERCURY_CONDITION_TYPE_URI, 1);
    expect(mercury.parse({
      connectorAccount: "mercury:main",
      transactionId: "tx-1",
      settlementState: "posted",
    })).toMatchObject({ transactionId: "tx-1" });
    expect(() => mercury.parse({
      connectorAccount: "mercury:main",
      settlementState: "posted",
      direction: "incoming",
    })).toThrow();
    const schema = REFERENCE_EXTENSION_MANIFEST.types.find((type) =>
      type.typeUri === MERCURY_CONDITION_TYPE_URI)?.schema;
    expect(JSON.stringify(schema)).toContain("incoming");
    expect(JSON.stringify(schema)).not.toContain("credit");
  });

  test("preserves exact v1 routing and decisions through URI resolution", () => {
    const identity = WAIT_KIND_EXTENSION_IDENTITIES["github.pull_request_state"];
    const evaluator = registry.evaluator(identity.evaluatorUri, 1);
    const parameters = registry.condition(identity.typeUri, 1).parse({
      host: "github.com",
      owner: "kami",
      repository: "robot",
      pullRequestNumber: 42,
      state: "merged",
      mergeCommitSha: "abcdef1",
    });
    const observationIdentity = evaluator.acceptedObservationTypes[0]!;
    const observation = registry.observation(
      observationIdentity.typeUri,
      observationIdentity.schemaVersion,
    ).parse({
      host: "github.com",
      owner: "kami",
      repository: "robot",
      pullRequestNumber: 42,
      state: "merged",
    });
    expect(evaluator.conditionRouteKeys(parameters)).toEqual([
      '["github.pull_request","github.com","kami","robot",42]',
    ]);
    expect(evaluator.evaluate(parameters, observation)).toEqual({
      decision: "ambiguous",
      reasonCode: "merge_commit_sha_missing",
      explanation: "Required typed field merge_commit_sha is missing from the observation.",
    });
  });
});
