/** v1 alias adapter over the generic trusted extension runtime registry. */

import { ExtensionRuntimeRegistry, type MatchDecision } from "@tasq/extension-sdk";
import {
  OBSERVATION_KIND_TYPE_URIS,
  REFERENCE_EXTENSION_RUNTIME,
  WAIT_KIND_EXTENSION_IDENTITIES,
} from "@tasq-internal/reference-extension";
import type {
  Metadata,
  Observation,
  ObservationKind,
  WaitCondition,
  WaitConditionKind,
} from "@tasq/schema";

export const BUNDLED_RUNTIME_REGISTRY = new ExtensionRuntimeRegistry([
  REFERENCE_EXTENSION_RUNTIME,
]);

export function parseReferenceCondition(
  kind: WaitConditionKind,
  schemaVersion: number,
  input: unknown,
): Metadata {
  const identity = WAIT_KIND_EXTENSION_IDENTITIES[kind];
  try {
    return BUNDLED_RUNTIME_REGISTRY.condition(identity.typeUri, schemaVersion).parse(input);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unsupported condition runtime:")) {
      throw new Error(`Unsupported wait condition schema: ${kind}@${schemaVersion}`);
    }
    throw error;
  }
}

export function parseReferenceObservation(
  kind: ObservationKind,
  schemaVersion: number,
  input: unknown,
): Metadata {
  const typeUri = OBSERVATION_KIND_TYPE_URIS[kind];
  try {
    return BUNDLED_RUNTIME_REGISTRY.observation(typeUri, schemaVersion).parse(input);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unsupported observation runtime:")) {
      throw new Error(`Unsupported observation schema: ${kind}@${schemaVersion}`);
    }
    throw error;
  }
}

export function deriveReferenceObservationSubjectRef(
  kind: ObservationKind,
  schemaVersion: number,
  payload: Metadata,
): string {
  return BUNDLED_RUNTIME_REGISTRY
    .observation(OBSERVATION_KIND_TYPE_URIS[kind], schemaVersion)
    .subjectRef(payload);
}

export function referenceObservationRouteKeys(observation: Observation): string[] {
  return Array.from(new Set(BUNDLED_RUNTIME_REGISTRY
    .observation(OBSERVATION_KIND_TYPE_URIS[observation.kind], observation.schemaVersion)
    .routeKeys(observation.payload)));
}

export function referenceConditionRouteKey(
  condition: WaitCondition,
  evaluatorVersion = 1,
): { observationKind: ObservationKind; routeKey: string } {
  const identity = WAIT_KIND_EXTENSION_IDENTITIES[condition.kind];
  let evaluator;
  try {
    evaluator = BUNDLED_RUNTIME_REGISTRY.evaluator(identity.evaluatorUri, evaluatorVersion);
  } catch {
    throw new Error(`Unsupported matcher version: ${condition.kind}@${evaluatorVersion}`);
  }
  const routeKey = evaluator.conditionRouteKeys(condition.parameters)[0];
  if (!routeKey) throw new Error(`Evaluator has no condition route: ${identity.evaluatorUri}`);
  return { observationKind: identity.observationKind, routeKey };
}

export function evaluateReferenceWaitObservation(
  condition: WaitCondition,
  observation: Observation,
  evaluatorVersion = 1,
): MatchDecision {
  const conditionIdentity = WAIT_KIND_EXTENSION_IDENTITIES[condition.kind];
  let evaluator;
  try {
    evaluator = BUNDLED_RUNTIME_REGISTRY.evaluator(
      conditionIdentity.evaluatorUri,
      evaluatorVersion,
    );
  } catch {
    throw new Error(`Unsupported matcher version: ${condition.kind}@${evaluatorVersion}`);
  }
  const expectedObservationTypeUri = OBSERVATION_KIND_TYPE_URIS[conditionIdentity.observationKind];
  const expectedObservation = evaluator.acceptedObservationTypes.find((accepted) =>
    accepted.typeUri === expectedObservationTypeUri);
  if (condition.schemaVersion !== evaluator.conditionType.schemaVersion
    || observation.schemaVersion !== expectedObservation?.schemaVersion) {
    throw new Error(
      `Matcher ${condition.kind}@${evaluatorVersion} does not support condition/observation schema versions ${condition.schemaVersion}/${observation.schemaVersion}`,
    );
  }
  if (observation.kind !== conditionIdentity.observationKind) {
    return {
      decision: "rejected",
      reasonCode: "observation_kind_mismatch",
      explanation: `Matcher ${condition.kind} does not accept observation kind ${observation.kind}.`,
    };
  }
  if (observation.occurredAt < condition.notBefore) {
    return {
      decision: "rejected",
      reasonCode: "occurred_before_not_before",
      explanation: "Observation occurred before the wait condition became eligible.",
    };
  }
  return evaluator.evaluate(condition.parameters, observation.payload);
}
