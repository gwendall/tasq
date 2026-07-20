import { describe, expect, test } from "bun:test";
import {
  ExtensionRuntimeRegistry,
  defineExtensionRuntime,
  type TasqExtensionRuntime,
} from "../src/index.js";

const schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  properties: { id: { type: "string" } },
  required: ["id"],
};

function roboticsRuntime(): TasqExtensionRuntime {
  const condition = { typeUri: "https://robot.example/conditions/at-station", schemaVersion: 1 };
  const observation = { typeUri: "https://robot.example/observations/scan", schemaVersion: 1 };
  const evaluator = {
    evaluatorUri: "https://robot.example/evaluators/at-station",
    evaluatorVersion: 1,
    implementationDigest: `sha256:${"a".repeat(64)}`,
    conditionType: condition,
    acceptedObservationTypes: [observation],
    conditionRouteKeys: (value: Record<string, unknown>) => [JSON.stringify(["station", value.id])],
    evaluate: (expected: Record<string, unknown>, actual: Record<string, unknown>) => ({
      decision: expected.id === actual.id ? "matched" as const : "rejected" as const,
      reasonCode: expected.id === actual.id ? "same_station" : "station_mismatch",
      explanation: expected.id === actual.id ? "Same station." : "Different station.",
    }),
  };
  return {
    manifest: {
      extensionUri: "https://robot.example/extension",
      version: "1.0.0",
      types: [
        { recordKind: "condition", ...condition, schema },
        { recordKind: "observation", ...observation, schema },
      ],
      evaluators: [{
        evaluatorUri: evaluator.evaluatorUri,
        evaluatorVersion: evaluator.evaluatorVersion,
        conditionTypeUri: condition.typeUri,
        conditionSchemaVersion: condition.schemaVersion,
        acceptedObservationTypes: [observation],
        implementationDigest: evaluator.implementationDigest,
      }],
    },
    conditions: [{ ...condition, parse: (value) => value as Record<string, unknown> }],
    observations: [{
      ...observation,
      parse: (value) => value as Record<string, unknown>,
      subjectRef: (value) => JSON.stringify(["station", value.id]),
      routeKeys: (value) => [JSON.stringify(["station", value.id])],
    }],
    evaluators: [evaluator],
  };
}

describe("extension runtime SDK", () => {
  test("loads and executes an unfamiliar domain without kernel source changes", () => {
    const runtime = defineExtensionRuntime(roboticsRuntime());
    const registry = new ExtensionRuntimeRegistry([runtime]);
    const condition = registry.condition(
      "https://robot.example/conditions/at-station",
      1,
    ).parse({ id: "station-7" });
    const observation = registry.observation(
      "https://robot.example/observations/scan",
      1,
    ).parse({ id: "station-7" });
    const evaluator = registry.evaluator("https://robot.example/evaluators/at-station", 1);
    expect(evaluator.conditionRouteKeys(condition)).toEqual(['["station","station-7"]']);
    expect(evaluator.evaluate(condition, observation)).toEqual({
      decision: "matched",
      reasonCode: "same_station",
      explanation: "Same station.",
    });
  });

  test("rejects manifest/runtime drift and duplicate loaded identities", () => {
    const drifted = roboticsRuntime();
    drifted.evaluators[0]!.implementationDigest = `sha256:${"b".repeat(64)}`;
    expect(() => defineExtensionRuntime(drifted)).toThrow(/differs from its manifest/);

    const runtime = defineExtensionRuntime(roboticsRuntime());
    expect(() => new ExtensionRuntimeRegistry([runtime, runtime])).toThrow(/already loaded/);
  });
});
