import { z } from "zod";
import type { ConditionTypeRuntime, EvaluatorRuntime, ObservationTypeRuntime } from "@tasq-run/extension-sdk";
import type { ExtensionManifestType, Metadata } from "@tasq-run/schema";
import { ambiguous, boundedString, matched, nullable, objectSchema, rejected, route } from "../shared.js";

export const FILESYSTEM_CONDITION_TYPE_URI = "https://schemas.tasq.dev/conditions/filesystem/artifact";
export const FILESYSTEM_OBSERVATION_TYPE_URI = "https://schemas.tasq.dev/observations/filesystem/stat";
export const FILESYSTEM_EVALUATOR_URI = "https://schemas.tasq.dev/evaluators/filesystem/artifact";

const FILE_KINDS = ["file", "directory", "symlink", "other"] as const;

export const FilesystemArtifactParameters = z.object({
  connectorRoot: z.string().min(1).max(1_000),
  relativePath: z.string().min(1).max(4_096),
  kind: z.enum(FILE_KINDS),
  sizeBytes: z.number().int().nonnegative().optional(),
  digest: z.string().min(1).max(500).optional(),
}).strict();

export const FilesystemStatObservationPayload = z.object({
  connectorRoot: z.string().min(1).max(1_000),
  relativePath: z.string().min(1).max(4_096),
  kind: z.enum(FILE_KINDS),
  sizeBytes: z.number().int().nonnegative().nullable().default(null),
  digest: z.string().min(1).max(500).nullable().default(null),
}).strict();

const filesystemProperties = {
  connectorRoot: boundedString(1_000),
  relativePath: boundedString(4_096),
  kind: { enum: [...FILE_KINDS] },
  sizeBytes: { type: "integer", minimum: 0 },
  digest: boundedString(500),
};

export const filesystemManifestTypes: ExtensionManifestType[] = [
  {
    recordKind: "condition",
    typeUri: FILESYSTEM_CONDITION_TYPE_URI,
    schemaVersion: 1,
    schema: objectSchema(filesystemProperties, ["connectorRoot", "relativePath", "kind"]),
  },
  {
    recordKind: "observation",
    typeUri: FILESYSTEM_OBSERVATION_TYPE_URI,
    schemaVersion: 1,
    schema: objectSchema({
      ...filesystemProperties,
      sizeBytes: nullable({ type: "integer", minimum: 0 }),
      digest: nullable(boundedString(500)),
    }, ["connectorRoot", "relativePath", "kind", "sizeBytes", "digest"]),
  },
];

const filesystemRoute = (payload: Metadata): string => route(
  "filesystem.stat",
  payload.connectorRoot,
  payload.relativePath,
);

export const filesystemConditionRuntime: ConditionTypeRuntime = {
  typeUri: FILESYSTEM_CONDITION_TYPE_URI,
  schemaVersion: 1,
  parse: (input) => FilesystemArtifactParameters.parse(input) as Metadata,
};

export const filesystemObservationRuntime: ObservationTypeRuntime = {
  typeUri: FILESYSTEM_OBSERVATION_TYPE_URI,
  schemaVersion: 1,
  parse: (input) => FilesystemStatObservationPayload.parse(input) as Metadata,
  subjectRef: filesystemRoute,
  routeKeys: (payload) => [filesystemRoute(payload)],
};

export function filesystemEvaluatorRuntime(implementationDigest: string): EvaluatorRuntime {
  return {
    evaluatorUri: FILESYSTEM_EVALUATOR_URI,
    evaluatorVersion: 1,
    implementationDigest,
    conditionType: { typeUri: FILESYSTEM_CONDITION_TYPE_URI, schemaVersion: 1 },
    acceptedObservationTypes: [{ typeUri: FILESYSTEM_OBSERVATION_TYPE_URI, schemaVersion: 1 }],
    conditionRouteKeys: (parameters) => [filesystemRoute(parameters)],
    evaluate: (parameters, observation) => {
      if (parameters.connectorRoot !== observation.connectorRoot) return rejected("connector_root");
      if (parameters.relativePath !== observation.relativePath) return rejected("relative_path");
      if (parameters.kind !== observation.kind) return rejected("artifact_kind");
      if (parameters.sizeBytes !== undefined) {
        if (observation.sizeBytes == null) return ambiguous("size_bytes");
        if (parameters.sizeBytes !== observation.sizeBytes) return rejected("size_bytes");
      }
      if (parameters.digest !== undefined) {
        if (observation.digest == null) return ambiguous("digest");
        if (parameters.digest !== observation.digest) return rejected("digest");
      }
      return matched();
    },
  };
}
