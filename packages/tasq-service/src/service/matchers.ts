/** Compatibility exports over the generic bundled extension runtime. */

import type { Observation, WaitCondition } from "@tasq-run/schema";
import type { Metadata, ObservationKind } from "@tasq-run/schema";
import {
  REFERENCE_EXTENSION_RUNTIME,
  WAIT_KIND_EXTENSION_IDENTITIES,
} from "@tasq-internal/reference-extension";
import type { MatchDecision } from "@tasq-run/extension-sdk";
import {
  evaluateReferenceWaitObservation,
  referenceConditionRouteKey,
  referenceObservationRouteKeys,
} from "./reference-runtime.js";

export type { MatchDecision } from "@tasq-run/extension-sdk";

const compatibilityMatchers = Object.fromEntries(
  Object.entries(WAIT_KIND_EXTENSION_IDENTITIES).map(([kind, identity]) => {
    const evaluator = REFERENCE_EXTENSION_RUNTIME.evaluators.find((candidate) =>
      candidate.evaluatorUri === identity.evaluatorUri && candidate.evaluatorVersion === 1);
    if (!evaluator) throw new Error(`Bundled evaluator is missing: ${identity.evaluatorUri}@1`);
    return [kind, Object.freeze({
      observationKind: identity.observationKind as ObservationKind,
      conditionRoute: (parameters: Metadata) => evaluator.conditionRouteKeys(parameters)[0]!,
      match: (parameters: Metadata, payload: Metadata) => evaluator.evaluate(parameters, payload),
    })];
  }),
);

/** Frozen legacy shape; implementations resolve from the reference package. */
export const MATCHER_REGISTRY = Object.freeze({ 1: Object.freeze(compatibilityMatchers) });

export function evaluateWaitObservation(
  condition: WaitCondition,
  observation: Observation,
  matcherVersion = 1,
): MatchDecision {
  return evaluateReferenceWaitObservation(condition, observation, matcherVersion);
}

export function conditionRouteKey(condition: WaitCondition, matcherVersion = 1) {
  return referenceConditionRouteKey(condition, matcherVersion);
}

export function observationRouteKeys(observation: Observation): string[] {
  return referenceObservationRouteKeys(observation);
}
