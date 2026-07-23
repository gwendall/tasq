/** Bundled five-domain extension used only by the v1 compatibility adapter. */

import { defineExtensionRuntime } from "@tasq-run/extension-sdk";
import type { ExtensionManifest, ExtensionManifestEvaluator } from "@tasq-run/schema";
import {
  GMAIL_CONDITION_TYPE_URI,
  GMAIL_EVALUATOR_URI,
  GMAIL_OBSERVATION_TYPE_URI,
  gmailConditionRuntime,
  gmailEvaluatorRuntime,
  gmailManifestTypes,
  gmailObservationRuntime,
} from "./domains/gmail.js";
import {
  GITHUB_CONDITION_TYPE_URI,
  GITHUB_EVALUATOR_URI,
  GITHUB_OBSERVATION_TYPE_URI,
  githubConditionRuntime,
  githubEvaluatorRuntime,
  githubManifestTypes,
  githubObservationRuntime,
} from "./domains/github.js";
import {
  MERCURY_CONDITION_TYPE_URI,
  MERCURY_EVALUATOR_URI,
  MERCURY_OBSERVATION_TYPE_URI,
  mercuryConditionRuntime,
  mercuryEvaluatorRuntime,
  mercuryManifestTypes,
  mercuryObservationRuntime,
} from "./domains/mercury.js";
import {
  HTTP_CONDITION_TYPE_URI,
  HTTP_EVALUATOR_URI,
  HTTP_OBSERVATION_TYPE_URI,
  httpConditionRuntime,
  httpEvaluatorRuntime,
  httpManifestTypes,
  httpObservationRuntime,
} from "./domains/http.js";
import {
  FILESYSTEM_CONDITION_TYPE_URI,
  FILESYSTEM_EVALUATOR_URI,
  FILESYSTEM_OBSERVATION_TYPE_URI,
  filesystemConditionRuntime,
  filesystemEvaluatorRuntime,
  filesystemManifestTypes,
  filesystemObservationRuntime,
} from "./domains/filesystem.js";

export * from "./domains/gmail.js";
export * from "./domains/github.js";
export * from "./domains/mercury.js";
export * from "./domains/http.js";
export * from "./domains/filesystem.js";

export const REFERENCE_EXTENSION_URI = "https://schemas.tasq.dev/extensions/reference-facts";
export const REFERENCE_EXTENSION_VERSION = "1.0.0";
export const REFERENCE_EVALUATOR_VERSION = 1;
export const REFERENCE_EVALUATOR_IMPLEMENTATION_DIGEST =
  "sha256:d616cb665c5e74912217a9f2074a3da15b2976f4ce50ce16a2c46bad3d91a161";

export const WAIT_KIND_EXTENSION_IDENTITIES = {
  "gmail.thread_reply": {
    typeUri: GMAIL_CONDITION_TYPE_URI,
    evaluatorUri: GMAIL_EVALUATOR_URI,
    observationKind: "gmail.message",
  },
  "github.pull_request_state": {
    typeUri: GITHUB_CONDITION_TYPE_URI,
    evaluatorUri: GITHUB_EVALUATOR_URI,
    observationKind: "github.pull_request",
  },
  "mercury.transaction_state": {
    typeUri: MERCURY_CONDITION_TYPE_URI,
    evaluatorUri: MERCURY_EVALUATOR_URI,
    observationKind: "mercury.transaction",
  },
  "http.response": {
    typeUri: HTTP_CONDITION_TYPE_URI,
    evaluatorUri: HTTP_EVALUATOR_URI,
    observationKind: "http.check",
  },
  "filesystem.artifact": {
    typeUri: FILESYSTEM_CONDITION_TYPE_URI,
    evaluatorUri: FILESYSTEM_EVALUATOR_URI,
    observationKind: "filesystem.stat",
  },
} as const;

export const OBSERVATION_KIND_TYPE_URIS = {
  "gmail.message": GMAIL_OBSERVATION_TYPE_URI,
  "github.pull_request": GITHUB_OBSERVATION_TYPE_URI,
  "mercury.transaction": MERCURY_OBSERVATION_TYPE_URI,
  "http.check": HTTP_OBSERVATION_TYPE_URI,
  "filesystem.stat": FILESYSTEM_OBSERVATION_TYPE_URI,
} as const;

export type ReferenceWaitKind = keyof typeof WAIT_KIND_EXTENSION_IDENTITIES;
export type ReferenceObservationKind = keyof typeof OBSERVATION_KIND_TYPE_URIS;

const conditions = [
  gmailConditionRuntime,
  githubConditionRuntime,
  mercuryConditionRuntime,
  httpConditionRuntime,
  filesystemConditionRuntime,
] as const;

const observations = [
  gmailObservationRuntime,
  githubObservationRuntime,
  mercuryObservationRuntime,
  httpObservationRuntime,
  filesystemObservationRuntime,
] as const;

const evaluators = [
  gmailEvaluatorRuntime(REFERENCE_EVALUATOR_IMPLEMENTATION_DIGEST),
  githubEvaluatorRuntime(REFERENCE_EVALUATOR_IMPLEMENTATION_DIGEST),
  mercuryEvaluatorRuntime(REFERENCE_EVALUATOR_IMPLEMENTATION_DIGEST),
  httpEvaluatorRuntime(REFERENCE_EVALUATOR_IMPLEMENTATION_DIGEST),
  filesystemEvaluatorRuntime(REFERENCE_EVALUATOR_IMPLEMENTATION_DIGEST),
] as const;

const evaluatorManifest: ExtensionManifestEvaluator[] = evaluators.map((evaluator) => ({
  evaluatorUri: evaluator.evaluatorUri,
  evaluatorVersion: evaluator.evaluatorVersion,
  conditionTypeUri: evaluator.conditionType.typeUri,
  conditionSchemaVersion: evaluator.conditionType.schemaVersion,
  acceptedObservationTypes: evaluator.acceptedObservationTypes.map((accepted) => ({ ...accepted })),
  implementationDigest: evaluator.implementationDigest,
}));

export const REFERENCE_EXTENSION_MANIFEST: ExtensionManifest = {
  extensionUri: REFERENCE_EXTENSION_URI,
  version: REFERENCE_EXTENSION_VERSION,
  types: [
    ...gmailManifestTypes,
    ...githubManifestTypes,
    ...mercuryManifestTypes,
    ...httpManifestTypes,
    ...filesystemManifestTypes,
  ],
  evaluators: evaluatorManifest,
};

export const REFERENCE_EXTENSION_RUNTIME = defineExtensionRuntime({
  manifest: REFERENCE_EXTENSION_MANIFEST,
  conditions,
  observations,
  evaluators,
});
