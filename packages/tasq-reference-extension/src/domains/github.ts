import { z } from "zod";
import type { ConditionTypeRuntime, EvaluatorRuntime, ObservationTypeRuntime } from "@tasq-run/extension-sdk";
import type { ExtensionManifestType, Metadata } from "@tasq-run/schema";
import { ambiguous, boundedString, matched, nullable, objectSchema, rejected, route } from "../shared.js";

export const GITHUB_CONDITION_TYPE_URI = "https://schemas.tasq.dev/conditions/github/pull-request-state";
export const GITHUB_OBSERVATION_TYPE_URI = "https://schemas.tasq.dev/observations/github/pull-request";
export const GITHUB_EVALUATOR_URI = "https://schemas.tasq.dev/evaluators/github/pull-request-state";

export const GithubPullRequestStateParameters = z.object({
  host: z.string().min(1).max(253),
  owner: z.string().min(1).max(200),
  repository: z.string().min(1).max(200),
  pullRequestNumber: z.number().int().positive(),
  state: z.enum(["open", "closed", "merged"]),
  mergeCommitSha: z.string().min(7).max(128).optional(),
}).strict();

export const GithubPullRequestObservationPayload = z.object({
  host: z.string().min(1).max(253),
  owner: z.string().min(1).max(200),
  repository: z.string().min(1).max(200),
  pullRequestNumber: z.number().int().positive(),
  state: z.enum(["open", "closed", "merged"]),
  mergeCommitSha: z.string().min(7).max(128).nullable().default(null),
}).strict();

const commonProperties = {
  host: boundedString(253),
  owner: boundedString(200),
  repository: boundedString(200),
  pullRequestNumber: { type: "integer", minimum: 1 },
  state: { enum: ["open", "closed", "merged"] },
};

export const githubManifestTypes: ExtensionManifestType[] = [
  {
    recordKind: "condition",
    typeUri: GITHUB_CONDITION_TYPE_URI,
    schemaVersion: 1,
    schema: objectSchema({
      ...commonProperties,
      mergeCommitSha: { type: "string", minLength: 7, maxLength: 128 },
    }, ["host", "owner", "repository", "pullRequestNumber", "state"]),
  },
  {
    recordKind: "observation",
    typeUri: GITHUB_OBSERVATION_TYPE_URI,
    schemaVersion: 1,
    schema: objectSchema({
      ...commonProperties,
      mergeCommitSha: nullable({ type: "string", minLength: 7, maxLength: 128 }),
    }, ["host", "owner", "repository", "pullRequestNumber", "state", "mergeCommitSha"]),
  },
];

const pullRequestRoute = (payload: Metadata): string => route(
  "github.pull_request",
  payload.host,
  payload.owner,
  payload.repository,
  payload.pullRequestNumber,
);

export const githubConditionRuntime: ConditionTypeRuntime = {
  typeUri: GITHUB_CONDITION_TYPE_URI,
  schemaVersion: 1,
  parse: (input) => GithubPullRequestStateParameters.parse(input) as Metadata,
};

export const githubObservationRuntime: ObservationTypeRuntime = {
  typeUri: GITHUB_OBSERVATION_TYPE_URI,
  schemaVersion: 1,
  parse: (input) => GithubPullRequestObservationPayload.parse(input) as Metadata,
  subjectRef: pullRequestRoute,
  routeKeys: (payload) => [pullRequestRoute(payload)],
};

export function githubEvaluatorRuntime(implementationDigest: string): EvaluatorRuntime {
  return {
    evaluatorUri: GITHUB_EVALUATOR_URI,
    evaluatorVersion: 1,
    implementationDigest,
    conditionType: { typeUri: GITHUB_CONDITION_TYPE_URI, schemaVersion: 1 },
    acceptedObservationTypes: [{ typeUri: GITHUB_OBSERVATION_TYPE_URI, schemaVersion: 1 }],
    conditionRouteKeys: (parameters) => [pullRequestRoute(parameters)],
    evaluate: (parameters, observation) => {
      if (parameters.host !== observation.host) return rejected("host");
      if (parameters.owner !== observation.owner) return rejected("owner");
      if (parameters.repository !== observation.repository) return rejected("repository");
      if (parameters.pullRequestNumber !== observation.pullRequestNumber) return rejected("pull_request_number");
      if (parameters.state !== observation.state) return rejected("state");
      if (parameters.mergeCommitSha !== undefined) {
        if (observation.mergeCommitSha == null) return ambiguous("merge_commit_sha");
        if (parameters.mergeCommitSha !== observation.mergeCommitSha) return rejected("merge_commit_sha");
      }
      return matched();
    },
  };
}
