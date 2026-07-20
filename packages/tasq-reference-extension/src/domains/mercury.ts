import { z } from "zod";
import type { ConditionTypeRuntime, EvaluatorRuntime, ObservationTypeRuntime } from "@tasq/extension-sdk";
import type { ExtensionManifestType, Metadata } from "@tasq/schema";
import { ambiguous, boundedString, matched, nullable, objectSchema, rejected, route } from "../shared.js";

export const MERCURY_CONDITION_TYPE_URI = "https://schemas.tasq.dev/conditions/mercury/transaction-state";
export const MERCURY_OBSERVATION_TYPE_URI = "https://schemas.tasq.dev/observations/mercury/transaction";
export const MERCURY_EVALUATOR_URI = "https://schemas.tasq.dev/evaluators/mercury/transaction-state";

export const MercuryTransactionStateParameters = z.object({
  connectorAccount: z.string().min(1).max(200),
  transactionId: z.string().min(1).max(500).optional(),
  direction: z.enum(["incoming", "outgoing"]).optional(),
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  minorUnits: z.number().int().nonnegative().optional(),
  counterparty: z.string().min(1).max(500).optional(),
  settlementState: z.string().min(1).max(100),
}).strict().superRefine((value, ctx) => {
  if (value.transactionId) return;
  for (const field of ["direction", "currency", "minorUnits", "counterparty"] as const) {
    if (value[field] === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field],
        message: `${field} is required when transactionId is absent`,
      });
    }
  }
});

export const MercuryTransactionObservationPayload = z.object({
  connectorAccount: z.string().min(1).max(200),
  transactionId: z.string().min(1).max(500),
  direction: z.enum(["incoming", "outgoing"]),
  currency: z.string().regex(/^[A-Z]{3}$/),
  minorUnits: z.number().int().nonnegative(),
  counterparty: z.string().min(1).max(500).nullable().default(null),
  settlementState: z.string().min(1).max(100),
}).strict();

const mercuryProperties = {
  connectorAccount: boundedString(200),
  transactionId: boundedString(500),
  direction: { enum: ["incoming", "outgoing"] },
  currency: { type: "string", pattern: "^[A-Z]{3}$" },
  minorUnits: { type: "integer", minimum: 0 },
  counterparty: boundedString(500),
  settlementState: boundedString(100),
};

export const mercuryManifestTypes: ExtensionManifestType[] = [
  {
    recordKind: "condition",
    typeUri: MERCURY_CONDITION_TYPE_URI,
    schemaVersion: 1,
    schema: objectSchema(mercuryProperties, ["connectorAccount", "settlementState"], {
      anyOf: [
        { required: ["transactionId"] },
        { required: ["direction", "currency", "minorUnits", "counterparty"] },
      ],
    }),
  },
  {
    recordKind: "observation",
    typeUri: MERCURY_OBSERVATION_TYPE_URI,
    schemaVersion: 1,
    schema: objectSchema({
      ...mercuryProperties,
      counterparty: nullable(boundedString(500)),
    }, [
      "connectorAccount", "transactionId", "direction", "currency", "minorUnits",
      "counterparty", "settlementState",
    ]),
  },
];

const transactionRoute = (payload: Metadata): string => route(
  "mercury.transaction",
  payload.connectorAccount,
  payload.transactionId,
);

const valueRoute = (payload: Metadata): string => route(
  "mercury.transaction.match",
  payload.connectorAccount,
  payload.direction,
  payload.currency,
  payload.minorUnits,
);

export const mercuryConditionRuntime: ConditionTypeRuntime = {
  typeUri: MERCURY_CONDITION_TYPE_URI,
  schemaVersion: 1,
  parse: (input) => MercuryTransactionStateParameters.parse(input) as Metadata,
};

export const mercuryObservationRuntime: ObservationTypeRuntime = {
  typeUri: MERCURY_OBSERVATION_TYPE_URI,
  schemaVersion: 1,
  parse: (input) => MercuryTransactionObservationPayload.parse(input) as Metadata,
  subjectRef: transactionRoute,
  routeKeys: (payload) => [transactionRoute(payload), valueRoute(payload)],
};

export function mercuryEvaluatorRuntime(implementationDigest: string): EvaluatorRuntime {
  return {
    evaluatorUri: MERCURY_EVALUATOR_URI,
    evaluatorVersion: 1,
    implementationDigest,
    conditionType: { typeUri: MERCURY_CONDITION_TYPE_URI, schemaVersion: 1 },
    acceptedObservationTypes: [{ typeUri: MERCURY_OBSERVATION_TYPE_URI, schemaVersion: 1 }],
    conditionRouteKeys: (parameters) => [
      parameters.transactionId !== undefined ? transactionRoute(parameters) : valueRoute(parameters),
    ],
    evaluate: (parameters, observation) => {
      if (parameters.connectorAccount !== observation.connectorAccount) return rejected("connector_account");
      if (parameters.transactionId !== undefined) {
        if (parameters.transactionId !== observation.transactionId) return rejected("transaction_id");
      } else {
        if (parameters.direction !== observation.direction) return rejected("direction");
        if (parameters.currency !== observation.currency) return rejected("currency");
        if (parameters.minorUnits !== observation.minorUnits) return rejected("minor_units");
        if (observation.counterparty == null) return ambiguous("counterparty");
        if (parameters.counterparty !== observation.counterparty) return rejected("counterparty");
      }
      if (parameters.settlementState !== observation.settlementState) return rejected("settlement_state");
      return matched();
    },
  };
}
