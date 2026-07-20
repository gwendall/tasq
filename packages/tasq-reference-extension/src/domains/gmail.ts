import { z } from "zod";
import type {
  ConditionTypeRuntime,
  EvaluatorRuntime,
  ObservationTypeRuntime,
} from "@tasq/extension-sdk";
import type { ExtensionManifestType, Metadata } from "@tasq/schema";
import { boundedString, matched, objectSchema, rejected, route } from "../shared.js";

export const GMAIL_CONDITION_TYPE_URI = "https://schemas.tasq.dev/conditions/gmail/thread-reply";
export const GMAIL_OBSERVATION_TYPE_URI = "https://schemas.tasq.dev/observations/gmail/message";
export const GMAIL_EVALUATOR_URI = "https://schemas.tasq.dev/evaluators/gmail/thread-reply";

export const GmailThreadReplyParameters = z.object({
  connectorAccount: z.string().min(1).max(200),
  threadId: z.string().min(1).max(500),
  sender: z.string().min(1).max(500).optional(),
}).strict();

export const GmailMessageObservationPayload = z.object({
  connectorAccount: z.string().min(1).max(200),
  messageId: z.string().min(1).max(500),
  threadId: z.string().min(1).max(500),
  sender: z.string().min(1).max(500),
}).strict();

export const gmailManifestTypes: ExtensionManifestType[] = [
  {
    recordKind: "condition",
    typeUri: GMAIL_CONDITION_TYPE_URI,
    schemaVersion: 1,
    schema: objectSchema({
      connectorAccount: boundedString(200),
      threadId: boundedString(500),
      sender: boundedString(500),
    }, ["connectorAccount", "threadId"]),
  },
  {
    recordKind: "observation",
    typeUri: GMAIL_OBSERVATION_TYPE_URI,
    schemaVersion: 1,
    schema: objectSchema({
      connectorAccount: boundedString(200),
      messageId: boundedString(500),
      threadId: boundedString(500),
      sender: boundedString(500),
    }, ["connectorAccount", "messageId", "threadId", "sender"]),
  },
];

export const gmailConditionRuntime: ConditionTypeRuntime = {
  typeUri: GMAIL_CONDITION_TYPE_URI,
  schemaVersion: 1,
  parse: (input) => GmailThreadReplyParameters.parse(input) as Metadata,
};

export const gmailObservationRuntime: ObservationTypeRuntime = {
  typeUri: GMAIL_OBSERVATION_TYPE_URI,
  schemaVersion: 1,
  parse: (input) => GmailMessageObservationPayload.parse(input) as Metadata,
  subjectRef: (payload) => route("gmail.message", payload.connectorAccount, payload.threadId),
  routeKeys: (payload) => [route("gmail.message", payload.connectorAccount, payload.threadId)],
};

export function gmailEvaluatorRuntime(implementationDigest: string): EvaluatorRuntime {
  return {
    evaluatorUri: GMAIL_EVALUATOR_URI,
    evaluatorVersion: 1,
    implementationDigest,
    conditionType: { typeUri: GMAIL_CONDITION_TYPE_URI, schemaVersion: 1 },
    acceptedObservationTypes: [{ typeUri: GMAIL_OBSERVATION_TYPE_URI, schemaVersion: 1 }],
    conditionRouteKeys: (parameters) => [
      route("gmail.message", parameters.connectorAccount, parameters.threadId),
    ],
    evaluate: (parameters, observation) => {
      if (parameters.connectorAccount !== observation.connectorAccount) return rejected("connector_account");
      if (parameters.threadId !== observation.threadId) return rejected("thread_id");
      if (parameters.sender !== undefined && parameters.sender !== observation.sender) return rejected("sender");
      return matched();
    },
  };
}
