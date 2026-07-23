/**
 * Trusted, headless runtime contract for Tasq extensions.
 *
 * This package has no database, provider, CLI or network knowledge. The durable
 * registry proves which meanings a workspace installed; this runtime registry
 * resolves those exact identities to trusted in-process parsers and pure code.
 */

import type {
  ExtensionManifest,
  ExtensionManifestEvaluator,
  ExtensionManifestType,
  Metadata,
  ReconciliationDecision,
} from "@tasq-run/schema";

export * from "./effects.js";
export * from "./connector-conformance.js";

export interface MatchDecision {
  decision: ReconciliationDecision;
  reasonCode: string;
  explanation: string;
}

export interface RuntimeTypeIdentity {
  typeUri: string;
  schemaVersion: number;
}

export interface ConditionTypeRuntime extends RuntimeTypeIdentity {
  parse(input: unknown): Metadata;
}

export interface ObservationTypeRuntime extends RuntimeTypeIdentity {
  parse(input: unknown): Metadata;
  subjectRef(payload: Metadata): string;
  routeKeys(payload: Metadata): readonly string[];
}

export interface EvaluatorRuntime {
  evaluatorUri: string;
  evaluatorVersion: number;
  implementationDigest: string;
  conditionType: RuntimeTypeIdentity;
  acceptedObservationTypes: readonly RuntimeTypeIdentity[];
  conditionRouteKeys(parameters: Metadata): readonly string[];
  evaluate(parameters: Metadata, observation: Metadata): MatchDecision;
}

export interface TasqExtensionRuntime {
  manifest: ExtensionManifest;
  conditions: readonly ConditionTypeRuntime[];
  observations: readonly ObservationTypeRuntime[];
  evaluators: readonly EvaluatorRuntime[];
}

function identity(uri: string, version: number): string {
  return `${uri}@${version}`;
}

function evaluatorIdentity(uri: string, version: number): string {
  return `${uri}@${version}`;
}

function assertUnique<T>(values: readonly T[], key: (value: T) => string, label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    const candidate = key(value);
    if (seen.has(candidate)) throw new Error(`Duplicate runtime ${label}: ${candidate}`);
    seen.add(candidate);
  }
}

function assertRuntimeMatchesManifest(runtime: TasqExtensionRuntime): void {
  assertUnique(runtime.conditions, (value) => identity(value.typeUri, value.schemaVersion), "condition");
  assertUnique(runtime.observations, (value) => identity(value.typeUri, value.schemaVersion), "observation");
  assertUnique(runtime.evaluators, (value) => evaluatorIdentity(
    value.evaluatorUri,
    value.evaluatorVersion,
  ), "evaluator");

  const manifestTypes = new Map(runtime.manifest.types.map((type) => [
    identity(type.typeUri, type.schemaVersion),
    type,
  ]));
  const requireType = (
    candidate: RuntimeTypeIdentity,
    recordKind: ExtensionManifestType["recordKind"],
  ): void => {
    const key = identity(candidate.typeUri, candidate.schemaVersion);
    const declared = manifestTypes.get(key);
    if (!declared || declared.recordKind !== recordKind) {
      throw new Error(`Runtime ${recordKind} is absent from its manifest: ${key}`);
    }
  };
  for (const condition of runtime.conditions) requireType(condition, "condition");
  for (const observation of runtime.observations) requireType(observation, "observation");
  for (const declared of runtime.manifest.types) {
    if (declared.recordKind === "condition"
      && !runtime.conditions.some((value) =>
        value.typeUri === declared.typeUri && value.schemaVersion === declared.schemaVersion)) {
      throw new Error(`Manifest condition has no runtime parser: ${identity(declared.typeUri, declared.schemaVersion)}`);
    }
    if (declared.recordKind === "observation"
      && !runtime.observations.some((value) =>
        value.typeUri === declared.typeUri && value.schemaVersion === declared.schemaVersion)) {
      throw new Error(`Manifest observation has no runtime parser: ${identity(declared.typeUri, declared.schemaVersion)}`);
    }
  }

  const manifestEvaluators = new Map(runtime.manifest.evaluators.map((evaluator) => [
    evaluatorIdentity(evaluator.evaluatorUri, evaluator.evaluatorVersion),
    evaluator,
  ]));
  for (const evaluator of runtime.evaluators) {
    const key = evaluatorIdentity(evaluator.evaluatorUri, evaluator.evaluatorVersion);
    const declared = manifestEvaluators.get(key);
    if (!declared || !sameEvaluatorDeclaration(evaluator, declared)) {
      throw new Error(`Runtime evaluator differs from its manifest: ${key}`);
    }
  }
  for (const declared of runtime.manifest.evaluators) {
    if (!runtime.evaluators.some((value) =>
      value.evaluatorUri === declared.evaluatorUri
      && value.evaluatorVersion === declared.evaluatorVersion)) {
      throw new Error(
        `Manifest evaluator has no runtime implementation: ${evaluatorIdentity(declared.evaluatorUri, declared.evaluatorVersion)}`,
      );
    }
  }
}

function sameEvaluatorDeclaration(
  runtime: EvaluatorRuntime,
  manifest: ExtensionManifestEvaluator,
): boolean {
  const runtimeAccepted = runtime.acceptedObservationTypes
    .map((value) => identity(value.typeUri, value.schemaVersion))
    .sort();
  const manifestAccepted = manifest.acceptedObservationTypes
    .map((value) => identity(value.typeUri, value.schemaVersion))
    .sort();
  return runtime.implementationDigest === manifest.implementationDigest
    && runtime.conditionType.typeUri === manifest.conditionTypeUri
    && runtime.conditionType.schemaVersion === manifest.conditionSchemaVersion
    && runtimeAccepted.length === manifestAccepted.length
    && runtimeAccepted.every((value, index) => value === manifestAccepted[index]);
}

/** Immutable process-local resolver for code that has already crossed trust policy. */
export class ExtensionRuntimeRegistry {
  readonly #conditions = new Map<string, ConditionTypeRuntime>();
  readonly #observations = new Map<string, ObservationTypeRuntime>();
  readonly #evaluators = new Map<string, EvaluatorRuntime>();

  constructor(extensions: readonly TasqExtensionRuntime[]) {
    for (const extension of extensions) {
      assertRuntimeMatchesManifest(extension);
      for (const condition of extension.conditions) {
        this.#add(this.#conditions, identity(condition.typeUri, condition.schemaVersion), condition);
      }
      for (const observation of extension.observations) {
        this.#add(this.#observations, identity(observation.typeUri, observation.schemaVersion), observation);
      }
      for (const evaluator of extension.evaluators) {
        this.#add(
          this.#evaluators,
          evaluatorIdentity(evaluator.evaluatorUri, evaluator.evaluatorVersion),
          evaluator,
        );
      }
    }
    for (const evaluator of this.#evaluators.values()) {
      this.#require(
        this.#conditions,
        identity(evaluator.conditionType.typeUri, evaluator.conditionType.schemaVersion),
        "condition runtime referenced by evaluator",
      );
      for (const accepted of evaluator.acceptedObservationTypes) {
        this.#require(
          this.#observations,
          identity(accepted.typeUri, accepted.schemaVersion),
          "observation runtime referenced by evaluator",
        );
      }
    }
  }

  condition(typeUri: string, schemaVersion: number): ConditionTypeRuntime {
    return this.#require(this.#conditions, identity(typeUri, schemaVersion), "condition runtime");
  }

  observation(typeUri: string, schemaVersion: number): ObservationTypeRuntime {
    return this.#require(this.#observations, identity(typeUri, schemaVersion), "observation runtime");
  }

  evaluator(evaluatorUri: string, evaluatorVersion: number): EvaluatorRuntime {
    return this.#require(
      this.#evaluators,
      evaluatorIdentity(evaluatorUri, evaluatorVersion),
      "evaluator runtime",
    );
  }

  #add<T>(registry: Map<string, T>, key: string, value: T): void {
    if (registry.has(key)) throw new Error(`Runtime identity already loaded: ${key}`);
    registry.set(key, Object.freeze(value));
  }

  #require<T>(registry: Map<string, T>, key: string, label: string): T {
    const value = registry.get(key);
    if (!value) throw new Error(`Unsupported ${label}: ${key}`);
    return value;
  }
}

export function defineExtensionRuntime(runtime: TasqExtensionRuntime): TasqExtensionRuntime {
  assertRuntimeMatchesManifest(runtime);
  return Object.freeze({
    ...runtime,
    conditions: Object.freeze([...runtime.conditions]),
    observations: Object.freeze([...runtime.observations]),
    evaluators: Object.freeze([...runtime.evaluators]),
  });
}
