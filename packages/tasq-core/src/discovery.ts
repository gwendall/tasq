/** UK-009: bounded, read-only machine discovery and cold-start negotiation. */

import { Buffer } from "node:buffer";
import { asc, eq } from "drizzle-orm";
import {
  ClientHello,
  DiscoveryDocument,
  DiscoverySchemaResource,
  ExtensionRecordKind,
  OnboardingResponse,
  TransportBoundary,
  extensionEvaluator,
  extensionRelease,
  extensionType,
  replicationAuthority,
  type Clock,
  type DiscoveryCapability,
  type DiscoveryCursor,
  type DiscoveryDocument as DiscoveryDocumentT,
  type DiscoveryExtension,
  type ReplicationDiscovery as ReplicationDiscoveryT,
  type DiscoverySchemaResource as DiscoverySchemaResourceT,
  type OnboardingProblem,
  type OnboardingResponse as OnboardingResponseT,
  type TransportBoundary as TransportBoundaryT,
} from "@tasq-run/schema";
import type { TasqDb, TasqDbOrTx } from "./db.js";
import { canonicalJson, sha256Digest } from "./util/canonical-json.js";
import { serviceNow } from "./util/clock.js";
import { replicationDiscoveryDescriptor } from "./service/replication.js";

export const TASQ_PROTOCOL_URI = "https://schemas.tasq.dev/protocols/tasq";
export const EVENT_CURSOR_URI = "https://schemas.tasq.dev/cursors/event-sequence";
export const OBSERVATION_CURSOR_URI = "https://schemas.tasq.dev/cursors/observation-recorded-at-id";
export const RESOURCE_EVENT_CURSOR_URI = "https://schemas.tasq.dev/cursors/resource-event-sequence";
export const REPLICATION_CURSOR_URI = "https://schemas.tasq.dev/cursors/authority-sequence";
export const REPLICATION_CAPABILITY_URI = "https://schemas.tasq.dev/capabilities/replication";

export const DISCOVERY_LIMITS = Object.freeze({
  documentBytes: 2 * 1024 * 1024,
  schemaBytes: 1 * 1024 * 1024,
  helloBytes: 256 * 1024,
  requiredItems: 256,
});
export const DISCOVERY_CACHE_MS = 5 * 60 * 1_000;

const WELL_KNOWN_RESOURCES = Object.freeze({
  discovery: "/.well-known/tasq" as const,
  schemaTemplate: "/.well-known/tasq/schemas/{resourceId}" as const,
  onboarding: "/.well-known/tasq/onboarding" as const,
});

interface CapabilityDefinition {
  name: string;
  operations: Readonly<Record<string, string>>;
}

const KERNEL_CAPABILITIES: readonly CapabilityDefinition[] = [
  { name: "spaces", operations: {
    bootstrap: "bootstrapCoordinationSpace", get: "getCoordinationSpace",
  } },
  { name: "commitments", operations: {
    create: "createCommitment", get: "getCommitment", list: "listCommitments",
    update: "updateCommitment", start: "startCommitment", complete: "completeCommitment",
    block: "blockCommitment", unblock: "unblockCommitment", cancel: "cancelCommitment",
    reopen: "reopenCommitment",
  } },
  { name: "principals", operations: {
    create: "createPrincipal", get: "getPrincipal", list: "listPrincipals", set_status: "setPrincipalStatus",
  } },
  { name: "assignments", operations: {
    propose: "proposeAssignment", get: "getAssignment", list: "listAssignments",
    accept: "acceptAssignment", reject: "rejectAssignment", revoke: "revokeAssignment",
    release: "releaseAssignment",
  } },
  { name: "relations", operations: {
    add: "addCommitmentRelation", get: "getCommitmentRelation", list: "listCommitmentRelations",
    end: "endCommitmentRelation",
  } },
  { name: "claims", operations: {
    acquire: "acquireTaskClaim", renew: "acquireTaskClaim", get: "getTaskClaim",
    get_active: "getActiveTaskClaim", list: "listTaskClaims", release: "releaseTaskClaim",
  } },
  { name: "resource-leases", operations: {
    acquire: "acquireResourceLease", renew: "renewResourceLease", release: "releaseResourceLease",
    verify: "verifyResourceFence", get: "getResourceLeaseView", list: "listResourceWorld",
    events: "listResourceEvents", sweep: "sweepExpiredResources",
  } },
  { name: "attempts", operations: {
    start: "startTaskAttempt", get: "getTaskAttempt", list: "listTaskAttempts",
    transition: "transitionTaskAttempt",
  } },
  { name: "artifacts", operations: {
    append: "appendArtifact", get: "getArtifact", list: "listArtifacts",
  } },
  { name: "evidence", operations: {
    append: "addTaskEvidence", get: "getTaskEvidence", list: "listTaskEvidence",
  } },
  { name: "completion-records", operations: {
    get: "getCompletionRecord", list: "listCompletionRecords",
  } },
  { name: "effects", operations: {
    propose: "proposeEffect", get: "getEffect", list: "listEffects",
    record_approval: "recordEffectApproval", get_approval: "getEffectApproval",
    list_approvals: "listEffectApprovals", get_effective_approval: "getEffectiveEffectApproval",
    authorize: "authorizeEffect", begin_execution: "beginEffectExecution", cancel: "cancelEffect",
    record_receipt: "recordEffectReceipt", get_receipt: "getEffectReceipt",
    list_receipts: "listEffectReceipts",
  } },
  { name: "inspection", operations: { inspect: "inspectCommitment" } },
  { name: "context-packets", operations: { build: "buildContextPacket" } },
  { name: "commitment-summaries", operations: {
    append: "appendCommitmentSummary", get: "getCommitmentSummary",
    list: "listCommitmentSummaries", list_current: "listCurrentCommitmentSummaries",
  } },
  { name: "external-context-links", operations: {
    attach: "attachExternalContextLink", detach: "detachExternalContextLink",
    get: "getExternalContextLink", list: "listExternalContextLinks",
  } },
  { name: "audit", operations: { get: "getEvent", list: "listEvents" } },
  { name: "extension-registry", operations: {
    discover: "getTasqDiscovery", get_schema: "getDiscoverySchema", negotiate: "negotiateOnboarding",
  } },
] as const;

const COMPATIBILITY_CAPABILITIES: readonly CapabilityDefinition[] = [
  { name: "conditions", operations: {
    create: "createWaitCondition", get: "getWaitCondition", list: "listWaitConditions",
    cancel: "cancelWaitCondition",
  } },
  { name: "observations", operations: {
    ingest: "ingestObservation", get: "getObservation", get_by_delivery: "getObservationByDelivery",
    list: "listObservations",
  } },
  { name: "reconciliations", operations: {
    evaluate: "reconcileWaitObservation", get: "getReconciliation", list: "listReconciliations",
    candidates: "listCandidateObservations",
  } },
  { name: "deadlines", operations: {
    evaluate: "evaluateWaitConditionDeadline", sweep: "sweepWaitConditionDeadlines",
  } },
] as const;

const REPLICATION_CAPABILITY: CapabilityDefinition = {
  name: "replication",
  operations: {
    push: "acceptReplicationPush",
    pull: "pullReplication",
    snapshot: "getReplicationSnapshot",
    conflicts: "listReplicationConflicts",
  },
};

/** Used only by conformance tests to prove every advertisement has an implementation export. */
export const DISCOVERY_CAPABILITY_IMPLEMENTATIONS = Object.freeze(Object.fromEntries(
  [...KERNEL_CAPABILITIES, ...COMPATIBILITY_CAPABILITIES, REPLICATION_CAPABILITY].map((definition) => [
    capabilityUri(definition.name),
    Object.freeze({ ...definition.operations }),
  ]),
));

export interface GetTasqDiscoveryOptions {
  workspaceId: string;
  transportBoundary?: TransportBoundaryT;
  capabilityProfile?: "kernel" | "compatibility";
  now?: number;
  clock?: Clock;
}

export interface GetDiscoverySchemaOptions {
  workspaceId: string;
}

interface RegistrySnapshot {
  extensions: DiscoveryExtension[];
  replication: ReplicationDiscoveryT | null;
}

function capabilityUri(name: string): string {
  return `https://schemas.tasq.dev/capabilities/${name}`;
}

function schemaResourceId(typeUri: string, schemaVersion: number): string {
  const digest = sha256Digest(`tasq.schema-resource.v1\0${typeUri}\0${schemaVersion}`);
  return `schema-v1-${digest.slice("sha256:".length)}`;
}

function stableCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function capabilityDocument(
  profile: "kernel" | "compatibility",
  replicationEnabled: boolean,
): DiscoveryCapability[] {
  const definitions: CapabilityDefinition[] = profile === "compatibility"
    ? [...KERNEL_CAPABILITIES, ...COMPATIBILITY_CAPABILITIES]
    : [...KERNEL_CAPABILITIES];
  if (replicationEnabled) definitions.push(REPLICATION_CAPABILITY);
  return definitions.map((definition) => ({
    uri: capabilityUri(definition.name),
    version: 1,
    operations: Object.keys(definition.operations),
  })).sort((left, right) => stableCompare(left.uri, right.uri));
}

const CURSORS_UNSORTED: DiscoveryCursor[] = [
  {
    uri: EVENT_CURSOR_URI,
    version: 1,
    fields: ["sequence"],
    ordering: "ascending_lexicographic",
    exclusive: true,
  },
  {
    uri: OBSERVATION_CURSOR_URI,
    version: 1,
    fields: ["recordedAt", "id"],
    ordering: "ascending_lexicographic",
    exclusive: true,
  },
  {
    uri: RESOURCE_EVENT_CURSOR_URI,
    version: 1,
    fields: ["sequence"],
    ordering: "ascending_lexicographic",
    exclusive: true,
  },
];
const CURSORS = CURSORS_UNSORTED.sort((left, right) => stableCompare(left.uri, right.uri));

function cursorDocument(replicationEnabled: boolean): DiscoveryCursor[] {
  const cursors = [...CURSORS];
  if (replicationEnabled) {
    cursors.push({
      uri: REPLICATION_CURSOR_URI,
      version: 1,
      fields: ["authorityReplicaId", "authorityEpoch", "authoritySequence"],
      ordering: "ascending_lexicographic",
      exclusive: true,
    });
  }
  return cursors.sort((left, right) => stableCompare(left.uri, right.uri));
}

/** One transaction produces a consistent extension/type/evaluator snapshot. */
async function readRegistry(db: TasqDb, workspaceId: string): Promise<RegistrySnapshot> {
  return db.transaction(async (tx) => {
    const [releases, types, evaluators, authorities] = await Promise.all([
      tx.select().from(extensionRelease).where(eq(extensionRelease.tenantId, workspaceId))
        .orderBy(asc(extensionRelease.extensionUri), asc(extensionRelease.version)),
      tx.select().from(extensionType).where(eq(extensionType.tenantId, workspaceId))
        .orderBy(asc(extensionType.typeUri), asc(extensionType.schemaVersion)),
      tx.select().from(extensionEvaluator).where(eq(extensionEvaluator.tenantId, workspaceId))
        .orderBy(asc(extensionEvaluator.evaluatorUri), asc(extensionEvaluator.evaluatorVersion)),
      tx.select().from(replicationAuthority)
        .where(eq(replicationAuthority.workspaceId, workspaceId)).limit(1),
    ]);
    if (releases.length > DISCOVERY_LIMITS.requiredItems) {
      throw new Error(`Discovery extension count exceeds ${DISCOVERY_LIMITS.requiredItems}`);
    }
    const extensions: DiscoveryExtension[] = [];
    for (const release of releases) {
      verifyCanonicalDigest(release.manifestJson, release.manifestDigest, "extension manifest");
      const releaseTypes = types.filter((type) => type.extensionReleaseId === release.id).map((type) => {
        const schemaBytes = verifyCanonicalDigest(type.schemaJson, type.schemaDigest, "extension schema");
        if (schemaBytes > DISCOVERY_LIMITS.schemaBytes) {
          throw new Error(`Extension schema exceeds discovery limit: ${type.typeUri}@${type.schemaVersion}`);
        }
        return {
          recordKind: ExtensionRecordKind.parse(type.recordKind),
          typeUri: type.typeUri,
          schemaVersion: type.schemaVersion,
          schemaDigest: type.schemaDigest,
          schemaBytes,
          resourceId: schemaResourceId(type.typeUri, type.schemaVersion),
        };
      });
      const releaseEvaluators = evaluators
        .filter((evaluator) => evaluator.extensionReleaseId === release.id)
        .map((evaluator) => {
          const acceptedObservationTypes = JSON.parse(evaluator.acceptedObservationTypes) as Array<{
            typeUri: string; schemaVersion: number;
          }>;
          if (canonicalJson(acceptedObservationTypes) !== evaluator.acceptedObservationTypes) {
            throw new Error("Extension evaluator accepted types are not canonical JSON");
          }
          return {
            evaluatorUri: evaluator.evaluatorUri,
            evaluatorVersion: evaluator.evaluatorVersion,
            conditionTypeUri: evaluator.conditionTypeUri,
            conditionSchemaVersion: evaluator.conditionSchemaVersion,
            acceptedObservationTypes,
            implementationDigest: evaluator.implementationDigest,
          };
        });
      extensions.push({
        extensionUri: release.extensionUri,
        version: release.version,
        manifestDigest: release.manifestDigest,
        types: releaseTypes,
        evaluators: releaseEvaluators,
      });
    }
    if (types.some((type) => !releases.some((release) => release.id === type.extensionReleaseId)) ||
      evaluators.some((evaluator) => !releases.some((release) => release.id === evaluator.extensionReleaseId))) {
      throw new Error("Discovery registry contains orphan extension registrations");
    }
    const authority = authorities[0];
    return {
      extensions,
      replication: authority
        ? replicationDiscoveryDescriptor({
            workspaceId,
            authorityReplicaId: authority.authorityReplicaId,
            authorityEpoch: authority.authorityEpoch,
            currentSequence: authority.currentSequence,
            minimumRetainedSequence: authority.minimumRetainedSequence,
          })
        : null,
    };
  });
}

function verifyCanonicalDigest(json: string, expectedDigest: string, label: string): number {
  const parsed = JSON.parse(json) as unknown;
  const canonical = canonicalJson(parsed);
  if (canonical !== json || sha256Digest(canonical) !== expectedDigest) {
    throw new Error(`${label} canonical content or digest has drifted`);
  }
  return Buffer.byteLength(canonical, "utf8");
}

function compatibilityPayload(document: Pick<DiscoveryDocumentT,
  "protocol" | "capabilities" | "extensions" | "cursors" | "resources" | "limits" | "replication">) {
  return {
    protocol: document.protocol,
    capabilities: document.capabilities,
    extensions: document.extensions,
    cursors: document.cursors,
    resources: document.resources,
    limits: document.limits,
    replication: document.replication,
  };
}

/** Read-only well-known discovery projection. */
export async function getTasqDiscovery(
  db: TasqDb,
  options: GetTasqDiscoveryOptions,
): Promise<DiscoveryDocumentT> {
  if (!options.workspaceId.trim()) throw new Error("Discovery workspaceId must not be blank");
  const generatedAt = serviceNow(options, options.now);
  const expiresAt = generatedAt + DISCOVERY_CACHE_MS;
  if (!Number.isSafeInteger(expiresAt)) throw new Error("Discovery cache expiry overflows unix-ms");
  const transportBoundary = TransportBoundary.parse(options.transportBoundary ?? "embedded");
  const registry = await readRegistry(db, options.workspaceId);
  const unsigned = {
    contractVersion: "tasq.discovery.v1" as const,
    generatedAt,
    expiresAt,
    workspaceId: options.workspaceId,
    transportBoundary,
    protocol: { uri: TASQ_PROTOCOL_URI, versions: [1] },
    capabilities: capabilityDocument(options.capabilityProfile ?? "kernel", registry.replication != null),
    extensions: registry.extensions,
    cursors: cursorDocument(registry.replication != null),
    resources: WELL_KNOWN_RESOURCES,
    limits: DISCOVERY_LIMITS,
    ...(registry.replication ? { replication: registry.replication } : {}),
  };
  const document = DiscoveryDocument.parse({
    ...unsigned,
    compatibilityDigest: sha256Digest(canonicalJson(compatibilityPayload(unsigned))),
  });
  if (Buffer.byteLength(canonicalJson(document), "utf8") > DISCOVERY_LIMITS.documentBytes) {
    throw new Error(`Discovery document exceeds ${DISCOVERY_LIMITS.documentBytes} bytes`);
  }
  return document;
}

/** Workspace-scoped, digest-verified schema retrieval by opaque discovery resource ID. */
export async function getDiscoverySchema(
  db: TasqDbOrTx,
  resourceId: string,
  options: GetDiscoverySchemaOptions,
): Promise<DiscoverySchemaResourceT | null> {
  if (!options.workspaceId.trim()) throw new Error("Discovery workspaceId must not be blank");
  if (!/^schema-v1-[0-9a-f]{64}$/.test(resourceId)) throw new Error("Invalid discovery schema resourceId");
  const rows = await db.select().from(extensionType)
    .where(eq(extensionType.tenantId, options.workspaceId))
    .orderBy(asc(extensionType.typeUri), asc(extensionType.schemaVersion))
    .limit(65_537);
  if (rows.length > 65_536) throw new Error("Discovery schema registry is too large to scan safely");
  const row = rows.find((candidate) =>
    schemaResourceId(candidate.typeUri, candidate.schemaVersion) === resourceId);
  if (!row) return null;
  const schemaBytes = verifyCanonicalDigest(row.schemaJson, row.schemaDigest, "extension schema");
  if (schemaBytes > DISCOVERY_LIMITS.schemaBytes) throw new Error("Discovery schema exceeds resource limit");
  return DiscoverySchemaResource.parse({
    contractVersion: "tasq.schema-resource.v1",
    resourceId,
    recordKind: row.recordKind,
    typeUri: row.typeUri,
    schemaVersion: row.schemaVersion,
    schema: JSON.parse(row.schemaJson) as Record<string, unknown>,
    schemaDigest: row.schemaDigest,
    schemaBytes,
  });
}

function problem(code: OnboardingProblem["code"], path: string, message: string): OnboardingProblem {
  return { code, path, message };
}

function invalidHello(document: DiscoveryDocumentT, message: string): OnboardingResponseT {
  return OnboardingResponse.parse({
    contractVersion: "tasq.onboarding.v1",
    status: "incompatible",
    selectedProtocolVersion: null,
    compatibilityDigest: document.compatibilityDigest,
    capabilities: [], types: [], cursors: [],
    problems: [problem("invalid_hello", "$", message)],
  });
}

/** Pure deterministic negotiation over one already-authenticated discovery snapshot. */
export function negotiateOnboarding(
  documentInput: DiscoveryDocumentT,
  helloInput: unknown,
): OnboardingResponseT {
  const document = DiscoveryDocument.parse(documentInput);
  let serialized: string;
  try {
    serialized = canonicalJson(helloInput);
  } catch (error) {
    return invalidHello(document, error instanceof Error ? error.message : "Client hello is not JSON");
  }
  if (Buffer.byteLength(serialized, "utf8") > document.limits.helloBytes) {
    return invalidHello(document, `Client hello exceeds ${document.limits.helloBytes} bytes`);
  }
  const parsed = ClientHello.safeParse(helloInput);
  if (!parsed.success) return invalidHello(document, parsed.error.issues.map((issue) => issue.message).join("; "));
  const hello = parsed.data;
  const mutualVersions = hello.supportedProtocolVersions
    .filter((version) => document.protocol.versions.includes(version))
    .sort((left, right) => right - left);
  if (hello.knownCompatibilityDigest && hello.knownCompatibilityDigest !== document.compatibilityDigest) {
    return OnboardingResponse.parse({
      contractVersion: "tasq.onboarding.v1",
      status: "refresh_required",
      selectedProtocolVersion: null,
      compatibilityDigest: document.compatibilityDigest,
      capabilities: [], types: [], cursors: [],
      problems: [problem("discovery_changed", "knownCompatibilityDigest",
        "Discovery compatibility state changed; inspect the fresh document before negotiating")],
    });
  }

  const problems: OnboardingProblem[] = [];
  if (mutualVersions.length === 0) {
    problems.push(problem("unsupported_protocol_version", "supportedProtocolVersions",
      "Client and server have no exact Tasq protocol version in common"));
  }
  const capabilities = hello.requiredCapabilities.flatMap((required, index) => {
    const found = document.capabilities.find((candidate) =>
      candidate.uri === required.uri && candidate.version === required.version);
    if (!found) {
      problems.push(problem("missing_capability", `requiredCapabilities[${index}]`,
        `Required capability is not available: ${required.uri}@${required.version}`));
      return [];
    }
    return [required];
  });
  const allTypes = document.extensions.flatMap((extension) => extension.types);
  const types = hello.requiredTypes.flatMap((required, index) => {
    const found = allTypes.find((candidate) =>
      candidate.typeUri === required.typeUri && candidate.schemaVersion === required.schemaVersion);
    if (!found) {
      problems.push(problem("missing_type", `requiredTypes[${index}]`,
        `Required type is not installed: ${required.typeUri}@${required.schemaVersion}`));
      return [];
    }
    if (required.schemaDigest && required.schemaDigest !== found.schemaDigest) {
      problems.push(problem("schema_digest_mismatch", `requiredTypes[${index}].schemaDigest`,
        `Required schema digest does not match ${required.typeUri}@${required.schemaVersion}`));
      return [];
    }
    if (hello.maxSchemaBytes !== undefined && found.schemaBytes > hello.maxSchemaBytes) {
      problems.push(problem("schema_too_large", `requiredTypes[${index}]`,
        `Required schema is ${found.schemaBytes} bytes, above client limit ${hello.maxSchemaBytes}`));
      return [];
    }
    return [{ ...required, schemaDigest: found.schemaDigest }];
  });
  const cursors = hello.requiredCursors.flatMap((required, index) => {
    const found = document.cursors.find((candidate) =>
      candidate.uri === required.uri && candidate.version === required.version);
    if (!found) {
      problems.push(problem("missing_cursor", `requiredCursors[${index}]`,
        `Required cursor is not available: ${required.uri}@${required.version}`));
      return [];
    }
    return [required];
  });
  problems.sort((left, right) =>
    stableCompare(left.code, right.code) || stableCompare(left.path, right.path) ||
    stableCompare(left.message, right.message));
  return OnboardingResponse.parse({
    contractVersion: "tasq.onboarding.v1",
    status: problems.length === 0 ? "compatible" : "incompatible",
    selectedProtocolVersion: mutualVersions[0] ?? null,
    compatibilityDigest: document.compatibilityDigest,
    capabilities: problems.length === 0 ? capabilities : [],
    types: problems.length === 0 ? types : [],
    cursors: problems.length === 0 ? cursors : [],
    problems,
  });
}
