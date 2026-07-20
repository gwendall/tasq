/** Language-neutral DTO schemas for UK-009 discovery and onboarding. */

import { z } from "zod";
import { EXTENSION_RECORD_KINDS, HttpsUri, Sha256Digest } from "./extensions.js";
import { ReplicationDiscovery } from "./replication.js";

const UnixMs = z.number().int().nonnegative();
const PositiveVersion = z.number().int().positive();
const Operation = z.string().regex(/^[a-z][a-z0-9_]*$/).max(100);
const ResourceId = z.string().regex(/^schema-v1-[0-9a-f]{64}$/);

export const DISCOVERY_CONTRACT_VERSION = "tasq.discovery.v1" as const;
export const SCHEMA_RESOURCE_CONTRACT_VERSION = "tasq.schema-resource.v1" as const;
export const CLIENT_HELLO_CONTRACT_VERSION = "tasq.client-hello.v1" as const;
export const ONBOARDING_CONTRACT_VERSION = "tasq.onboarding.v1" as const;

export const TransportBoundary = z.enum([
  "embedded",
  "local_process",
  "authenticated_remote",
]);
export type TransportBoundary = z.infer<typeof TransportBoundary>;

export const DiscoveryCapability = z.object({
  uri: HttpsUri,
  version: PositiveVersion,
  operations: z.array(Operation).min(1).max(100),
}).strict();
export type DiscoveryCapability = z.infer<typeof DiscoveryCapability>;

export const DiscoveryType = z.object({
  recordKind: z.enum(EXTENSION_RECORD_KINDS),
  typeUri: HttpsUri,
  schemaVersion: PositiveVersion,
  schemaDigest: Sha256Digest,
  schemaBytes: z.number().int().nonnegative(),
  resourceId: ResourceId,
}).strict();
export type DiscoveryType = z.infer<typeof DiscoveryType>;

export const DiscoveryEvaluator = z.object({
  evaluatorUri: HttpsUri,
  evaluatorVersion: PositiveVersion,
  conditionTypeUri: HttpsUri,
  conditionSchemaVersion: PositiveVersion,
  acceptedObservationTypes: z.array(z.object({
    typeUri: HttpsUri,
    schemaVersion: PositiveVersion,
  }).strict()).min(1).max(256),
  implementationDigest: Sha256Digest,
}).strict();
export type DiscoveryEvaluator = z.infer<typeof DiscoveryEvaluator>;

export const DiscoveryExtension = z.object({
  extensionUri: HttpsUri,
  version: z.string().min(1).max(200),
  manifestDigest: Sha256Digest,
  types: z.array(DiscoveryType).max(256),
  evaluators: z.array(DiscoveryEvaluator).max(256),
}).strict();
export type DiscoveryExtension = z.infer<typeof DiscoveryExtension>;

export const DiscoveryCursor = z.object({
  uri: HttpsUri,
  version: PositiveVersion,
  fields: z.array(z.string().min(1).max(100)).min(1).max(8),
  ordering: z.literal("ascending_lexicographic"),
  exclusive: z.literal(true),
}).strict();
export type DiscoveryCursor = z.infer<typeof DiscoveryCursor>;

export const DiscoveryLimits = z.object({
  documentBytes: z.number().int().positive(),
  schemaBytes: z.number().int().positive(),
  helloBytes: z.number().int().positive(),
  requiredItems: z.number().int().positive(),
}).strict();
export type DiscoveryLimits = z.infer<typeof DiscoveryLimits>;

export const DiscoveryDocument = z.object({
  contractVersion: z.literal(DISCOVERY_CONTRACT_VERSION),
  generatedAt: UnixMs,
  expiresAt: UnixMs,
  workspaceId: z.string().min(1).max(1_000),
  transportBoundary: TransportBoundary,
  protocol: z.object({
    uri: HttpsUri,
    versions: z.array(PositiveVersion).min(1).max(16),
  }).strict(),
  capabilities: z.array(DiscoveryCapability).max(256),
  extensions: z.array(DiscoveryExtension).max(256),
  cursors: z.array(DiscoveryCursor).max(32),
  resources: z.object({
    discovery: z.literal("/.well-known/tasq"),
    schemaTemplate: z.literal("/.well-known/tasq/schemas/{resourceId}"),
    onboarding: z.literal("/.well-known/tasq/onboarding"),
  }).strict(),
  limits: DiscoveryLimits,
  /** Present only after the workspace has initialized shipped replication. */
  replication: ReplicationDiscovery.optional(),
  compatibilityDigest: Sha256Digest,
}).strict().refine((value) => value.expiresAt >= value.generatedAt, {
  message: "expiresAt must not precede generatedAt",
});
export type DiscoveryDocument = z.infer<typeof DiscoveryDocument>;

export const DiscoverySchemaResource = z.object({
  contractVersion: z.literal(SCHEMA_RESOURCE_CONTRACT_VERSION),
  resourceId: ResourceId,
  recordKind: z.enum(EXTENSION_RECORD_KINDS),
  typeUri: HttpsUri,
  schemaVersion: PositiveVersion,
  schema: z.record(z.unknown()),
  schemaDigest: Sha256Digest,
  schemaBytes: z.number().int().nonnegative(),
}).strict();
export type DiscoverySchemaResource = z.infer<typeof DiscoverySchemaResource>;

const RequiredCapability = z.object({
  uri: HttpsUri,
  version: PositiveVersion,
}).strict();
const RequiredType = z.object({
  typeUri: HttpsUri,
  schemaVersion: PositiveVersion,
  schemaDigest: Sha256Digest.optional(),
}).strict();
const RequiredCursor = z.object({
  uri: HttpsUri,
  version: PositiveVersion,
}).strict();

function uniqueBy<T>(items: T[], identity: (item: T) => string): boolean {
  return new Set(items.map(identity)).size === items.length;
}

export const ClientHello = z.object({
  contractVersion: z.literal(CLIENT_HELLO_CONTRACT_VERSION),
  supportedProtocolVersions: z.array(PositiveVersion).min(1).max(16),
  requiredCapabilities: z.array(RequiredCapability).max(256).default([]),
  requiredTypes: z.array(RequiredType).max(256).default([]),
  requiredCursors: z.array(RequiredCursor).max(256).default([]),
  knownCompatibilityDigest: Sha256Digest.optional(),
  maxSchemaBytes: z.number().int().positive().max(1_048_576).optional(),
}).strict().superRefine((value, context) => {
  const checks: Array<[unknown[], (item: any) => string, string]> = [
    [value.supportedProtocolVersions, (item) => String(item), "supportedProtocolVersions"],
    [value.requiredCapabilities, (item) => `${item.uri}@${item.version}`, "requiredCapabilities"],
    [value.requiredTypes, (item) => `${item.typeUri}@${item.schemaVersion}`, "requiredTypes"],
    [value.requiredCursors, (item) => `${item.uri}@${item.version}`, "requiredCursors"],
  ];
  for (const [items, identity, path] of checks) {
    if (!uniqueBy(items, identity)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `${path} contains duplicates`, path: [path] });
    }
  }
});
export type ClientHello = z.infer<typeof ClientHello>;

export const ONBOARDING_PROBLEM_CODES = [
  "unsupported_protocol_version",
  "discovery_changed",
  "missing_capability",
  "missing_type",
  "schema_digest_mismatch",
  "schema_too_large",
  "missing_cursor",
  "invalid_hello",
] as const;
export const OnboardingProblemCode = z.enum(ONBOARDING_PROBLEM_CODES);
export type OnboardingProblemCode = z.infer<typeof OnboardingProblemCode>;

export const OnboardingProblem = z.object({
  code: OnboardingProblemCode,
  path: z.string().min(1).max(1_000),
  message: z.string().min(1).max(2_000),
}).strict();
export type OnboardingProblem = z.infer<typeof OnboardingProblem>;

export const OnboardingResponse = z.object({
  contractVersion: z.literal(ONBOARDING_CONTRACT_VERSION),
  status: z.enum(["compatible", "incompatible", "refresh_required"]),
  selectedProtocolVersion: PositiveVersion.nullable(),
  compatibilityDigest: Sha256Digest,
  capabilities: z.array(RequiredCapability).max(256),
  types: z.array(RequiredType.required({ schemaDigest: true })).max(256),
  cursors: z.array(RequiredCursor).max(256),
  problems: z.array(OnboardingProblem).max(1_024),
}).strict().superRefine((value, context) => {
  const negotiatedCount = value.capabilities.length + value.types.length + value.cursors.length;
  if (value.status === "compatible" && (value.selectedProtocolVersion == null || value.problems.length > 0)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "compatible response requires a protocol and no problems" });
  }
  if (value.status !== "compatible" && (value.problems.length === 0 || negotiatedCount > 0)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "non-compatible response requires problems and no negotiated subset" });
  }
  if (value.status === "refresh_required" && (
    value.selectedProtocolVersion != null ||
    value.problems.some((problem) => problem.code !== "discovery_changed")
  )) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "refresh response may contain only discovery_changed problems" });
  }
});
export type OnboardingResponse = z.infer<typeof OnboardingResponse>;
