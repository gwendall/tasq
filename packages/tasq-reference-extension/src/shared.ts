import type { MatchDecision } from "@tasq/extension-sdk";

export const JSON_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";

export function objectSchema(
  properties: Record<string, unknown>,
  required: readonly string[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    $schema: JSON_SCHEMA_DIALECT,
    type: "object",
    additionalProperties: false,
    properties,
    required: [...required],
    ...extra,
  };
}

export function boundedString(maxLength: number): Record<string, unknown> {
  return { type: "string", minLength: 1, maxLength };
}

export function nullable(schema: Record<string, unknown>): Record<string, unknown> {
  return { anyOf: [schema, { type: "null" }] };
}

export const HTTP_METHODS = [
  "GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS",
] as const;

export const matched = (): MatchDecision => ({
  decision: "matched",
  reasonCode: "all_typed_checks_matched",
  explanation: "All required typed fields matched exactly.",
});

export const rejected = (field: string): MatchDecision => ({
  decision: "rejected",
  reasonCode: `${field}_mismatch`,
  explanation: `Required typed field ${field} did not match.`,
});

export const ambiguous = (field: string): MatchDecision => ({
  decision: "ambiguous",
  reasonCode: `${field}_missing`,
  explanation: `Required typed field ${field} is missing from the observation.`,
});

export function route(namespace: string, ...parts: unknown[]): string {
  return JSON.stringify([namespace, ...parts]);
}
