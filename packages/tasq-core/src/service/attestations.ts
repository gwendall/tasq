/** Provider-neutral attestation ledger. Assertions, eligibility, and authority stay separate. */

import { and, asc, eq, lte } from "drizzle-orm";
import {
  AttestationEligibilityDecisionV1,
  AttestationIssueInputV1,
  AttestationRequirementV1,
  AttestationRevocationV1,
  AttestationSubjectV1,
  AttestationV1,
  StatementBinderDescriptorV1,
  attestation,
  attestationClaimDigest,
  attestationDigest,
  attestationRevocation,
  attestationRevocationDigest,
  canonicalScope,
  uuidv7,
  type AttestationEligibilityDecisionV1 as EligibilityDecision,
  type AttestationIssueInputV1 as IssueInput,
  type AttestationRequirementV1 as Requirement,
  type AttestationRevocationV1 as Revocation,
  type AttestationSubjectV1 as Subject,
  type AttestationV1 as Attestation,
} from "@tasq-run/schema";
import type { TasqDb, TasqDbOrTx } from "../db.js";
import { runInTransaction } from "../db.js";
import { canonicalJson } from "../util/canonical-json.js";
import { serviceNow } from "../util/clock.js";
import type { ServiceContext } from "./context.js";
import {
  findIdempotencyResult,
  prepareIdempotency,
  saveIdempotencyResult,
} from "./idempotency.js";
import type { TrustedStatementBinder } from "./signed-statements.js";

export const ATTESTATION_ISSUANCE_PURPOSE =
  "https://schemas.tasq.dev/purposes/attestation-issuance/v1" as const;
export const ATTESTATION_SUBJECT_TYPE =
  "https://schemas.tasq.dev/subjects/attestation/v1" as const;

export const ATTESTATION_ISSUANCE_BINDER_DESCRIPTOR = StatementBinderDescriptorV1.parse({
  contractVersion: "tasq.statement-binder.v1",
  bindingKind: "attestation_issuance",
  purposeUri: ATTESTATION_ISSUANCE_PURPOSE,
  purposeVersion: 1,
  subjectTypeUri: ATTESTATION_SUBJECT_TYPE,
  allowedProfileUris: [],
  nonceMode: "unique",
  maximumAgeMs: null,
  expectedRevisionRequired: false,
  onlineAuthorizationRequired: false,
  binderUri: "https://schemas.tasq.dev/binders/attestation-issuance/v1",
  binderVersion: 1,
  binderImplementationDigest: "sha256:3f5648c6ec7f4b9e0dc7d52ae53f5af30c588dd9b8b238f6025311754048b5b4",
  recordType: "attestation",
});

export const ATTESTATION_ISSUANCE_BINDER_PIN = Object.freeze({
  uri: ATTESTATION_ISSUANCE_BINDER_DESCRIPTOR.binderUri,
  version: ATTESTATION_ISSUANCE_BINDER_DESCRIPTOR.binderVersion,
  implementationDigest: ATTESTATION_ISSUANCE_BINDER_DESCRIPTOR.binderImplementationDigest,
});

export const ATTESTATION_ISSUANCE_BINDER: TrustedStatementBinder = {
  descriptor: ATTESTATION_ISSUANCE_BINDER_DESCRIPTOR,
  async assertTarget({ tx, workspaceId, payload, binding }) {
    const rows = await tx.select().from(attestation).where(and(
      eq(attestation.tenantId, workspaceId),
      eq(attestation.id, binding.recordId),
    )).limit(1);
    const row = rows[0];
    if (!row || payload.subject.id !== row.id || binding.recordDigest !== row.attestationDigest) {
      throw new Error("bound attestation digest not found");
    }
    if (payload.issuerPrincipalId !== row.issuerPrincipalId) {
      throw new Error("attestation statement issuer does not match attestation issuer");
    }
  },
};

function parseAttestation(row: typeof attestation.$inferSelect): Attestation {
  return AttestationV1.parse({
    contractVersion: "tasq.attestation.v1",
    id: row.id,
    workspaceId: row.tenantId,
    issuerPrincipalId: row.issuerPrincipalId,
    subject: { typeUri: row.subjectTypeUri, id: row.subjectId, digest: row.subjectDigest },
    purpose: { uri: row.purposeUri, version: row.purposeVersion },
    scope: JSON.parse(row.scopeJson),
    claim: { typeUri: row.claimTypeUri, version: row.claimVersion, value: JSON.parse(row.claimJson) },
    claimDigest: row.claimDigest,
    evidence: JSON.parse(row.evidenceJson),
    notBefore: row.notBefore,
    expiresAt: row.expiresAt,
    supersedesAttestationId: row.supersedesAttestationId,
    attestationDigest: row.attestationDigest,
    issuedAt: row.issuedAt,
    metadata: JSON.parse(row.metadataJson),
  });
}

function parseRevocation(row: typeof attestationRevocation.$inferSelect): Revocation {
  return AttestationRevocationV1.parse({
    contractVersion: "tasq.attestation-revocation.v1",
    id: row.id,
    workspaceId: row.tenantId,
    attestationId: row.attestationId,
    revokerPrincipalId: row.revokerPrincipalId,
    reasonCode: row.reasonCode,
    explanation: row.explanation,
    effectiveAt: row.effectiveAt,
    recordedAt: row.recordedAt,
    revocationDigest: row.revocationDigest,
    metadata: JSON.parse(row.metadataJson),
  });
}

function requireAuthenticatedPrincipal(ctx: ServiceContext): string {
  if (!ctx.principalId?.trim()) throw new Error("authenticated principalId is required");
  return ctx.principalId;
}

export async function issueAttestation(
  db: TasqDb,
  input: unknown,
  ctx: ServiceContext = {},
): Promise<Attestation> {
  const parsed = AttestationIssueInputV1.parse(input);
  const workspaceId = ctx.tenantId ?? "gwendall";
  const issuerPrincipalId = requireAuthenticatedPrincipal(ctx);
  const now = serviceNow(ctx, ctx.now);
  const notBefore = parsed.notBefore ?? now;
  const scope = canonicalScope(parsed.scope);
  const claimDigest = attestationClaimDigest(parsed.claim);
  const id = parsed.id ?? uuidv7(now);
  const retry = prepareIdempotency({ ...ctx, tenantId: workspaceId }, "attestation.issue", {
    issuerPrincipalId,
    input: parsed,
  }, { now });
  return runInTransaction(db, async (tx) => {
    const prior = await findIdempotencyResult(tx, retry);
    if (prior) {
      const replay = await getAttestation(tx, prior.resultId, workspaceId);
      if (!replay) throw new Error(`idempotency record points at missing attestation ${prior.resultId}`);
      return replay;
    }
    if (parsed.supersedesAttestationId) {
      const predecessor = await getAttestation(tx, parsed.supersedesAttestationId, workspaceId);
      if (!predecessor) throw new Error("superseded attestation not found in workspace");
      if (predecessor.issuerPrincipalId !== issuerPrincipalId ||
        canonicalJson(predecessor.subject) !== canonicalJson(parsed.subject) ||
        canonicalJson(predecessor.purpose) !== canonicalJson(parsed.purpose) ||
        canonicalJson(predecessor.scope) !== canonicalJson(scope)) {
        throw new Error("supersession must preserve issuer, subject, purpose, and scope");
      }
      if (notBefore < predecessor.notBefore) throw new Error("successor cannot become valid before predecessor");
    }
    const withoutDigest = {
      contractVersion: "tasq.attestation.v1" as const,
      id, workspaceId, issuerPrincipalId,
      subject: parsed.subject,
      purpose: parsed.purpose,
      scope,
      claim: parsed.claim,
      claimDigest,
      evidence: parsed.evidence,
      notBefore,
      expiresAt: parsed.expiresAt,
      supersedesAttestationId: parsed.supersedesAttestationId,
      issuedAt: now,
      metadata: parsed.metadata,
    };
    const result = AttestationV1.parse({
      ...withoutDigest,
      attestationDigest: attestationDigest(withoutDigest),
    });
    await tx.insert(attestation).values({
      id: result.id,
      tenantId: workspaceId,
      issuerPrincipalId,
      subjectTypeUri: result.subject.typeUri,
      subjectId: result.subject.id,
      subjectDigest: result.subject.digest,
      purposeUri: result.purpose.uri,
      purposeVersion: result.purpose.version,
      scopeJson: canonicalJson(result.scope),
      claimTypeUri: result.claim.typeUri,
      claimVersion: result.claim.version,
      claimJson: canonicalJson(result.claim.value),
      claimDigest: result.claimDigest,
      evidenceJson: canonicalJson(result.evidence),
      notBefore: result.notBefore,
      expiresAt: result.expiresAt,
      supersedesAttestationId: result.supersedesAttestationId,
      attestationDigest: result.attestationDigest,
      issuedAt: result.issuedAt,
      metadataJson: canonicalJson(result.metadata),
    });
    await saveIdempotencyResult(tx, retry, {
      resultType: "attestation",
      resultId: result.id,
    });
    return result;
  });
}

export async function revokeAttestation(
  db: TasqDb,
  attestationId: string,
  input: { reasonCode: string; explanation?: string | null; effectiveAt?: number; metadata?: unknown },
  ctx: ServiceContext = {},
): Promise<Revocation> {
  const workspaceId = ctx.tenantId ?? "gwendall";
  const revokerPrincipalId = requireAuthenticatedPrincipal(ctx);
  const now = serviceNow(ctx, ctx.now);
  const request = {
    attestationId,
    revokerPrincipalId,
    reasonCode: input.reasonCode,
    explanation: input.explanation ?? null,
    effectiveAt: input.effectiveAt ?? null,
    metadata: input.metadata ?? {},
  };
  const retry = prepareIdempotency({ ...ctx, tenantId: workspaceId }, "attestation.revoke", request, { now });
  return runInTransaction(db, async (tx) => {
    const prior = await findIdempotencyResult(tx, retry);
    if (prior) {
      const rows = await tx.select().from(attestationRevocation).where(and(
        eq(attestationRevocation.tenantId, workspaceId),
        eq(attestationRevocation.id, prior.resultId),
      )).limit(1);
      if (!rows[0]) throw new Error(`idempotency record points at missing attestation revocation ${prior.resultId}`);
      return parseRevocation(rows[0]);
    }
    const target = await getAttestation(tx, attestationId, workspaceId);
    if (!target) throw new Error("attestation not found in workspace");
    if (target.issuerPrincipalId !== revokerPrincipalId) {
      throw new Error("only the authenticated attestation issuer may revoke it");
    }
    const withoutDigest: Omit<Revocation, "revocationDigest"> = {
      contractVersion: "tasq.attestation-revocation.v1",
      id: uuidv7(now), workspaceId, attestationId, revokerPrincipalId,
      reasonCode: request.reasonCode,
      explanation: request.explanation,
      effectiveAt: request.effectiveAt ?? now,
      recordedAt: now,
      metadata: request.metadata as Revocation["metadata"],
    };
    const result = AttestationRevocationV1.parse({
      ...withoutDigest,
      revocationDigest: attestationRevocationDigest(withoutDigest),
    });
    await tx.insert(attestationRevocation).values({
      id: result.id, tenantId: workspaceId, attestationId,
      revokerPrincipalId, reasonCode: result.reasonCode, explanation: result.explanation,
      effectiveAt: result.effectiveAt, recordedAt: result.recordedAt,
      revocationDigest: result.revocationDigest, metadataJson: canonicalJson(result.metadata),
    });
    await saveIdempotencyResult(tx, retry, {
      resultType: "attestation_revocation",
      resultId: result.id,
    });
    return result;
  });
}

export async function getAttestation(
  db: TasqDbOrTx,
  id: string,
  workspaceId = "gwendall",
): Promise<Attestation | null> {
  const rows = await db.select().from(attestation).where(and(
    eq(attestation.tenantId, workspaceId), eq(attestation.id, id),
  )).limit(1);
  return rows[0] ? parseAttestation(rows[0]) : null;
}

export async function getAttestationRevocation(
  db: TasqDbOrTx,
  attestationId: string,
  workspaceId = "gwendall",
): Promise<Revocation | null> {
  const rows = await db.select().from(attestationRevocation).where(and(
    eq(attestationRevocation.tenantId, workspaceId),
    eq(attestationRevocation.attestationId, attestationId),
  )).limit(1);
  return rows[0] ? parseRevocation(rows[0]) : null;
}

export interface ListCurrentAttestationsInput {
  workspaceId?: string;
  subject: Subject;
  at: number;
  purpose?: { uri: string; version: number };
}

export async function listCurrentAttestations(
  db: TasqDbOrTx,
  input: ListCurrentAttestationsInput,
): Promise<Attestation[]> {
  const workspaceId = input.workspaceId ?? "gwendall";
  const subject = AttestationSubjectV1.parse(input.subject);
  if (!Number.isSafeInteger(input.at) || input.at < 0) throw new Error("authority time must be a non-negative unix-ms integer");
  const filters = [
    eq(attestation.tenantId, workspaceId),
    eq(attestation.subjectTypeUri, subject.typeUri),
    eq(attestation.subjectId, subject.id),
    lte(attestation.notBefore, input.at),
  ];
  if (input.purpose) {
    filters.push(eq(attestation.purposeUri, input.purpose.uri));
    filters.push(eq(attestation.purposeVersion, input.purpose.version));
  }
  const candidates = (await db.select().from(attestation).where(and(...filters))
    .orderBy(asc(attestation.notBefore), asc(attestation.id))).map(parseAttestation)
    .filter((candidate) => candidate.subject.digest === subject.digest)
    .filter((candidate) => candidate.expiresAt == null || candidate.expiresAt > input.at);
  if (candidates.length === 0) return [];
  const candidateIds = new Set(candidates.map(({ id }) => id));
  const superseded = new Set(candidates
    .filter(({ supersedesAttestationId }) => supersedesAttestationId && candidateIds.has(supersedesAttestationId))
    .map(({ supersedesAttestationId }) => supersedesAttestationId!));
  const revocations = await db.select().from(attestationRevocation).where(and(
    eq(attestationRevocation.tenantId, workspaceId),
    lte(attestationRevocation.effectiveAt, input.at),
  ));
  const revoked = new Set(revocations.map(({ attestationId }) => attestationId));
  return candidates.filter(({ id }) => !superseded.has(id) && !revoked.has(id));
}

export async function evaluateAttestationEligibility(
  db: TasqDbOrTx,
  input: { workspaceId?: string; subject: Subject; requirements: Requirement[]; at: number },
): Promise<EligibilityDecision> {
  const workspaceId = input.workspaceId ?? "gwendall";
  const subject = AttestationSubjectV1.parse(input.subject);
  const requirements = input.requirements.map((value) => AttestationRequirementV1.parse(value));
  const basis = new Set<string>();
  const unsatisfied: number[] = [];
  for (const [index, requirement] of requirements.entries()) {
    const current = await listCurrentAttestations(db, {
      workspaceId, subject, at: input.at, purpose: requirement.purpose,
    });
    const match = current.find((candidate) =>
      requirement.acceptedIssuerPrincipalIds.includes(candidate.issuerPrincipalId) &&
      candidate.claim.typeUri === requirement.claimTypeUri &&
      candidate.claim.version === requirement.claimVersion &&
      (requirement.claimDigest == null || candidate.claimDigest === requirement.claimDigest) &&
      requirement.requiredScope.every((entry) =>
        candidate.scope.some((candidateEntry) => canonicalJson(candidateEntry) === canonicalJson(entry))));
    if (match) basis.add(match.id); else unsatisfied.push(index);
  }
  return AttestationEligibilityDecisionV1.parse({
    contractVersion: "tasq.attestation-eligibility-decision.v1",
    workspaceId, subject, authorityTime: input.at,
    outcome: unsatisfied.length === 0 ? "eligible" : "ineligible",
    basisAttestationIds: [...basis].sort(),
    unsatisfiedRequirementIndexes: unsatisfied,
    assurance: {
      issuerAuthentication: "not_asserted_by_eligibility",
      claimTruth: "not_asserted",
      authority: "not_granted",
      availability: "not_asserted",
    },
  });
}

export function attestationStatementBinding(attestationRecord: Attestation) {
  return {
    bindingKind: "attestation_issuance",
    recordType: "attestation",
    recordId: attestationRecord.id,
    recordDigest: attestationRecord.attestationDigest,
    expectedBinder: ATTESTATION_ISSUANCE_BINDER_PIN,
  } as const;
}

/** Stable helper for fixtures and host registries to verify the pinned implementation. */
