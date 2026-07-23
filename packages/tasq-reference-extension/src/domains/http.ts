import { z } from "zod";
import type { ConditionTypeRuntime, EvaluatorRuntime, ObservationTypeRuntime } from "@tasq-run/extension-sdk";
import type { ExtensionManifestType, Metadata } from "@tasq-run/schema";
import { ambiguous, boundedString, HTTP_METHODS, matched, nullable, objectSchema, rejected, route } from "../shared.js";

export const HTTP_CONDITION_TYPE_URI = "https://schemas.tasq.dev/conditions/http/response";
export const HTTP_OBSERVATION_TYPE_URI = "https://schemas.tasq.dev/observations/http/check";
export const HTTP_EVALUATOR_URI = "https://schemas.tasq.dev/evaluators/http/response";

export const HttpResponseParameters = z.object({
  url: z.string().url().max(4_096),
  method: z.enum(HTTP_METHODS),
  allowedStatuses: z.array(z.number().int().min(100).max(599)).min(1).max(100),
  bodyDigest: z.string().min(1).max(500).optional(),
}).strict();

export const HttpCheckObservationPayload = z.object({
  url: z.string().url().max(4_096),
  method: z.enum(HTTP_METHODS),
  statusCode: z.number().int().min(100).max(599),
  bodyDigest: z.string().min(1).max(500).nullable().default(null),
}).strict();

const url = { type: "string", format: "uri", maxLength: 4_096 };
const method = { enum: [...HTTP_METHODS] };

export const httpManifestTypes: ExtensionManifestType[] = [
  {
    recordKind: "condition",
    typeUri: HTTP_CONDITION_TYPE_URI,
    schemaVersion: 1,
    schema: objectSchema({
      url,
      method,
      allowedStatuses: {
        type: "array",
        minItems: 1,
        maxItems: 100,
        items: { type: "integer", minimum: 100, maximum: 599 },
      },
      bodyDigest: boundedString(500),
    }, ["url", "method", "allowedStatuses"]),
  },
  {
    recordKind: "observation",
    typeUri: HTTP_OBSERVATION_TYPE_URI,
    schemaVersion: 1,
    schema: objectSchema({
      url,
      method,
      statusCode: { type: "integer", minimum: 100, maximum: 599 },
      bodyDigest: nullable(boundedString(500)),
    }, ["url", "method", "statusCode", "bodyDigest"]),
  },
];

const httpRoute = (payload: Metadata): string => route("http.check", payload.method, payload.url);

export const httpConditionRuntime: ConditionTypeRuntime = {
  typeUri: HTTP_CONDITION_TYPE_URI,
  schemaVersion: 1,
  parse: (input) => HttpResponseParameters.parse(input) as Metadata,
};

export const httpObservationRuntime: ObservationTypeRuntime = {
  typeUri: HTTP_OBSERVATION_TYPE_URI,
  schemaVersion: 1,
  parse: (input) => HttpCheckObservationPayload.parse(input) as Metadata,
  subjectRef: httpRoute,
  routeKeys: (payload) => [httpRoute(payload)],
};

export function httpEvaluatorRuntime(implementationDigest: string): EvaluatorRuntime {
  return {
    evaluatorUri: HTTP_EVALUATOR_URI,
    evaluatorVersion: 1,
    implementationDigest,
    conditionType: { typeUri: HTTP_CONDITION_TYPE_URI, schemaVersion: 1 },
    acceptedObservationTypes: [{ typeUri: HTTP_OBSERVATION_TYPE_URI, schemaVersion: 1 }],
    conditionRouteKeys: (parameters) => [httpRoute(parameters)],
    evaluate: (parameters, observation) => {
      if (parameters.url !== observation.url) return rejected("url");
      if (parameters.method !== observation.method) return rejected("method");
      if (!(parameters.allowedStatuses as unknown[]).includes(observation.statusCode)) return rejected("status_code");
      if (parameters.bodyDigest !== undefined) {
        if (observation.bodyDigest == null) return ambiguous("body_digest");
        if (parameters.bodyDigest !== observation.bodyDigest) return rejected("body_digest");
      }
      return matched();
    },
  };
}
