/** Exact multi-party agreement lifecycle and atomic compilation. */

import { and, asc, eq } from "drizzle-orm";
import {
  AgreementAcceptanceV1,
  AgreementActivationV1,
  AgreementOfferInputV1,
  AgreementOfferV1,
  AgreementTerminationV1,
  AgreementTermsV1,
  AgreementViewV1,
  ResolutionContractInsert,
  StatementBinderDescriptorV1,
  TaskInsert,
  agreementAcceptance,
  agreementAcceptanceDigest,
  agreementActivation,
  agreementActivationDigest,
  agreementOffer,
  agreementTermination,
  agreementTermsDigest,
  uuidv7,
  type AgreementAcceptanceV1 as Acceptance,
  type AgreementActivationV1 as Activation,
  type AgreementOfferV1 as Offer,
  type AgreementTerminationV1 as Termination,
  type AgreementViewV1 as AgreementView,
  type Event,
  type Metadata,
} from "@tasq-run/schema";
import type { TasqDb, TasqDbOrTx } from "../db.js";
import { runInTransaction } from "../db.js";
import { canonicalJson } from "../util/canonical-json.js";
import { serviceNow } from "../util/clock.js";
import type { ServiceContext } from "./context.js";
import { emitAfterCommit } from "./events.js";
import { findIdempotencyResult, prepareIdempotency, saveIdempotencyResult } from "./idempotency.js";
import { getPrincipal } from "./principals.js";
import { createResolutionContractInTransaction } from "./resolution.js";
import type { TrustedStatementBinder } from "./signed-statements.js";
import type { SignedStatementBinderInput } from "./signed-statements.js";
import { createTaskInTransaction, getTask, transitionTaskStatus } from "./tasks.js";

const MAX_TERMS_BYTES = 65_536;

export const AGREEMENT_ACCEPTANCE_PURPOSE =
  "https://schemas.tasq.dev/purposes/agreement-acceptance/v1" as const;
export const AGREEMENT_ACCEPTANCE_SUBJECT_TYPE =
  "https://schemas.tasq.dev/subjects/agreement-acceptance/v1" as const;

export const AGREEMENT_ACCEPTANCE_BINDER_DESCRIPTOR = StatementBinderDescriptorV1.parse({
  contractVersion: "tasq.statement-binder.v1",
  bindingKind: "agreement_acceptance",
  purposeUri: AGREEMENT_ACCEPTANCE_PURPOSE,
  purposeVersion: 1,
  subjectTypeUri: AGREEMENT_ACCEPTANCE_SUBJECT_TYPE,
  allowedProfileUris: [],
  nonceMode: "unique",
  maximumAgeMs: null,
  expectedRevisionRequired: false,
  onlineAuthorizationRequired: false,
  binderUri: "https://schemas.tasq.dev/binders/agreement-acceptance/v1",
  binderVersion: 1,
  binderImplementationDigest: "sha256:5bd5104e3f93488a628ba9627b92b18e5ea5a7ea574717d22908ed78e1957df7",
  recordType: "agreement_acceptance",
});

export const AGREEMENT_ACCEPTANCE_BINDER_PIN = Object.freeze({
  uri: AGREEMENT_ACCEPTANCE_BINDER_DESCRIPTOR.binderUri,
  version: AGREEMENT_ACCEPTANCE_BINDER_DESCRIPTOR.binderVersion,
  implementationDigest: AGREEMENT_ACCEPTANCE_BINDER_DESCRIPTOR.binderImplementationDigest,
});

function authenticatedPrincipal(ctx: ServiceContext): string {
  if (!ctx.principalId?.trim()) throw new Error("authenticated principalId is required");
  return ctx.principalId;
}

function parseOffer(row: typeof agreementOffer.$inferSelect): Offer {
  return AgreementOfferV1.parse({
    contractVersion: "tasq.agreement-offer.v1", id: row.id, workspaceId: row.tenantId,
    offerorPrincipalId: row.offerorPrincipalId, terms: JSON.parse(row.termsJson),
    termsDigest: row.termsDigest, expiresAt: row.expiresAt,
    supersedesOfferId: row.supersedesOfferId, offeredAt: row.offeredAt,
    metadata: JSON.parse(row.metadataJson),
  });
}

function parseAcceptance(row: typeof agreementAcceptance.$inferSelect): Acceptance {
  return AgreementAcceptanceV1.parse({
    contractVersion: "tasq.agreement-acceptance.v1", id: row.id, workspaceId: row.tenantId,
    offerId: row.offerId, partyPrincipalId: row.partyPrincipalId, termsDigest: row.termsDigest,
    acceptanceDigest: row.acceptanceDigest, acceptedAt: row.acceptedAt,
    metadata: JSON.parse(row.metadataJson),
  });
}

function parseTermination(row: typeof agreementTermination.$inferSelect): Termination {
  return AgreementTerminationV1.parse({
    contractVersion: "tasq.agreement-termination.v1", id: row.id, workspaceId: row.tenantId,
    offerId: row.offerId, actorPrincipalId: row.actorPrincipalId, action: row.action,
    termsDigest: row.termsDigest, reason: row.reason, terminatedAt: row.terminatedAt,
    metadata: JSON.parse(row.metadataJson),
  });
}

function parseActivation(row: typeof agreementActivation.$inferSelect): Activation {
  return AgreementActivationV1.parse({
    contractVersion: "tasq.agreement-activation.v1", id: row.id, workspaceId: row.tenantId,
    offerId: row.offerId, termsDigest: row.termsDigest,
    acceptanceIds: JSON.parse(row.acceptanceIdsJson), compilations: JSON.parse(row.compilationsJson),
    supersedesActivationId: row.supersedesActivationId, activatedAt: row.activatedAt,
    activationDigest: row.activationDigest,
  });
}

async function requireEnabledParties(db: TasqDbOrTx, workspaceId: string, principalIds: string[]): Promise<void> {
  for (const id of principalIds) {
    const party = await getPrincipal(db, id, workspaceId);
    if (!party || party.status !== "enabled") throw new Error(`agreement party is not enabled in workspace: ${id}`);
  }
}

export async function offerAgreement(db: TasqDb, input: unknown, ctx: ServiceContext = {}): Promise<Offer> {
  const parsed = AgreementOfferInputV1.parse(input);
  const workspaceId = ctx.tenantId ?? "gwendall";
  const offerorPrincipalId = authenticatedPrincipal(ctx);
  const now = serviceNow(ctx, ctx.now);
  const terms = AgreementTermsV1.parse(parsed.terms);
  const termsJson = canonicalJson(terms);
  if (Buffer.byteLength(termsJson, "utf8") > MAX_TERMS_BYTES) throw new Error(`agreement terms exceed ${MAX_TERMS_BYTES} bytes`);
  const termsDigest = agreementTermsDigest(terms);
  const retry = prepareIdempotency({ ...ctx, tenantId: workspaceId }, "agreement.offer", {
    offerorPrincipalId, input: parsed, termsDigest,
  }, { now });
  return runInTransaction(db, async (tx) => {
    const prior = await findIdempotencyResult(tx, retry);
    if (prior) {
      const replay = await getAgreementOffer(tx, prior.resultId, workspaceId);
      if (!replay) throw new Error(`idempotency record points at missing agreement offer ${prior.resultId}`);
      return replay;
    }
    await requireEnabledParties(tx, workspaceId, terms.parties.map(({ principalId }) => principalId));
    if (!terms.parties.some(({ principalId }) => principalId === offerorPrincipalId)) {
      throw new Error("authenticated offeror must be one of the agreement parties");
    }
    if (parsed.expiresAt <= now) throw new Error("agreement offer expiry must be in the future");
    if (parsed.supersedesOfferId) {
      const predecessor = await getAgreementView(tx, parsed.supersedesOfferId, workspaceId, now);
      if (!predecessor) throw new Error("superseded agreement offer not found in workspace");
      if (predecessor.state === "superseded") throw new Error("agreement offer already has an accepted successor");
      const priorParties = predecessor.offer.terms.parties.map(({ principalId }) => principalId);
      const nextParties = terms.parties.map(({ principalId }) => principalId);
      if (canonicalJson(priorParties) !== canonicalJson(nextParties)) {
        throw new Error("amendment must preserve the exact party set; use a new agreement for different parties");
      }
    }
    const offer = AgreementOfferV1.parse({
      contractVersion: "tasq.agreement-offer.v1", id: parsed.id ?? uuidv7(now), workspaceId,
      offerorPrincipalId, terms, termsDigest, expiresAt: parsed.expiresAt,
      supersedesOfferId: parsed.supersedesOfferId, offeredAt: now, metadata: parsed.metadata,
    });
    await tx.insert(agreementOffer).values({
      id: offer.id, tenantId: workspaceId, offerorPrincipalId, termsJson,
      termsDigest, expiresAt: offer.expiresAt, supersedesOfferId: offer.supersedesOfferId,
      offeredAt: now, metadataJson: canonicalJson(offer.metadata),
    });
    await saveIdempotencyResult(tx, retry, { resultType: "agreement_offer", resultId: offer.id, resultStatus: "offered" });
    return offer;
  });
}

export async function getAgreementOffer(db: TasqDbOrTx, id: string, workspaceId = "gwendall"): Promise<Offer | null> {
  const rows = await db.select().from(agreementOffer).where(and(
    eq(agreementOffer.tenantId, workspaceId), eq(agreementOffer.id, id),
  )).limit(1);
  return rows[0] ? parseOffer(rows[0]) : null;
}

async function acceptedSuccessorOfferId(db: TasqDbOrTx, workspaceId: string, rootOfferId: string): Promise<string | null> {
  let current = rootOfferId;
  const seen = new Set<string>([current]);
  for (let depth = 0; depth < 100; depth += 1) {
    const rows = await db.select({ id: agreementOffer.id }).from(agreementOffer).where(and(
      eq(agreementOffer.tenantId, workspaceId), eq(agreementOffer.supersedesOfferId, current),
    )).limit(1);
    const successorId = rows[0]?.id;
    if (!successorId) return null;
    if (seen.has(successorId)) throw new Error("agreement amendment chain contains a cycle");
    seen.add(successorId);
    const activated = await db.select({ id: agreementActivation.id }).from(agreementActivation).where(and(
      eq(agreementActivation.tenantId, workspaceId), eq(agreementActivation.offerId, successorId),
    )).limit(1);
    if (activated[0]) return successorId;
    current = successorId;
  }
  throw new Error("agreement amendment chain exceeds 100 offers");
}

async function nearestAncestorActivation(db: TasqDbOrTx, offer: Offer): Promise<Activation | null> {
  let predecessorId = offer.supersedesOfferId;
  const seen = new Set<string>();
  for (let depth = 0; predecessorId && depth < 100; depth += 1) {
    if (seen.has(predecessorId)) throw new Error("agreement amendment chain contains a cycle");
    seen.add(predecessorId);
    const activationRows = await db.select().from(agreementActivation).where(and(
      eq(agreementActivation.tenantId, offer.workspaceId), eq(agreementActivation.offerId, predecessorId),
    )).limit(1);
    if (activationRows[0]) return parseActivation(activationRows[0]);
    const predecessor = await getAgreementOffer(db, predecessorId, offer.workspaceId);
    predecessorId = predecessor?.supersedesOfferId ?? null;
  }
  if (predecessorId) throw new Error("agreement amendment chain exceeds 100 offers");
  return null;
}

export async function getAgreementView(
  db: TasqDbOrTx, offerId: string, workspaceId: string, authorityTime: number,
): Promise<AgreementView | null> {
  if (!Number.isSafeInteger(authorityTime) || authorityTime < 0) throw new Error("agreement authority time must be a non-negative unix-ms integer");
  const offer = await getAgreementOffer(db, offerId, workspaceId);
  if (!offer) return null;
  const acceptances = (await db.select().from(agreementAcceptance).where(and(
    eq(agreementAcceptance.tenantId, workspaceId), eq(agreementAcceptance.offerId, offerId),
  )).orderBy(asc(agreementAcceptance.partyPrincipalId))).map(parseAcceptance);
  const terminationRows = await db.select().from(agreementTermination).where(and(
    eq(agreementTermination.tenantId, workspaceId), eq(agreementTermination.offerId, offerId),
  )).limit(1);
  const activationRows = await db.select().from(agreementActivation).where(and(
    eq(agreementActivation.tenantId, workspaceId), eq(agreementActivation.offerId, offerId),
  )).limit(1);
  const termination = terminationRows[0] ? parseTermination(terminationRows[0]) : null;
  const activation = activationRows[0] ? parseActivation(activationRows[0]) : null;
  const supersededByOfferId = await acceptedSuccessorOfferId(db, workspaceId, offerId);
  const state = supersededByOfferId ? "superseded" : activation ? "accepted" : termination?.action ??
    (authorityTime >= offer.expiresAt ? "expired" : "offered");
  return AgreementViewV1.parse({
    contractVersion: "tasq.agreement-view.v1", offer, state, acceptances, termination,
    activation, supersededByOfferId, authorityTime,
    assurance: { assignmentAcceptanceIsAgreement: false, effectAuthorityGranted: false },
  });
}

export async function listAgreementOffers(db: TasqDbOrTx, workspaceId = "gwendall"): Promise<Offer[]> {
  return (await db.select().from(agreementOffer).where(eq(agreementOffer.tenantId, workspaceId))
    .orderBy(asc(agreementOffer.offeredAt), asc(agreementOffer.id))).map(parseOffer);
}

async function compileActivation(input: {
  tx: TasqDbOrTx; offer: Offer; acceptances: Acceptance[]; actor: string;
  principalId: string; now: number;
}): Promise<{ activation: Activation; events: Event[] }> {
  const { tx, offer, acceptances, actor, principalId, now } = input;
  const supersedesActivation = await nearestAncestorActivation(tx, offer);
  if (supersedesActivation) {
    for (const compiled of supersedesActivation.compilations) {
      const priorTask = await getTask(tx, compiled.commitmentId, offer.workspaceId);
      if (priorTask && priorTask.status !== "done" && priorTask.status !== "cancelled") {
        await transitionTaskStatus(tx as TasqDb, priorTask.id, "cancelled", {
          tenantId: offer.workspaceId, actor, principalId, now, expectedRevision: priorTask.revision,
          reason: `Superseded by accepted agreement amendment ${offer.id}`,
          source: `agreement:${offer.id}`,
          idempotencyKey: `agreement:${offer.id}:cancel:${priorTask.id}`,
        });
      }
    }
  }
  const compilations: Array<{ obligationId: string; commitmentId: string; resolutionContractId: string }> = [];
  const events: Event[] = [];
  for (const obligation of offer.terms.obligations) {
    const task = await createTaskInTransaction(tx, TaskInsert.parse({
      tenantId: offer.workspaceId, title: obligation.commitment.title,
      description: obligation.commitment.description, successCriteria: obligation.commitment.successCriteria,
      completionMode: "evidence", validationRequired: true, status: "open",
      scheduledAt: obligation.commitment.notBefore, dueAt: obligation.commitment.dueAt,
      priority: obligation.commitment.priority,
      metadata: {
        ...obligation.commitment.metadata,
        agreementOfferId: offer.id,
        agreementTermsDigest: offer.termsDigest,
        agreementObligationId: obligation.id,
        obligorPrincipalId: obligation.obligorPrincipalId,
        beneficiaryPrincipalId: obligation.beneficiaryPrincipalId,
      },
    }), {
      tenantId: offer.workspaceId, actor, principalId, now,
      eventContext: { source: `agreement:${offer.id}`, reason: `accepted obligation ${obligation.id}` },
    });
    events.push(task.event);
    const policy = obligation.resolutionPolicy;
    const resolution = await createResolutionContractInTransaction(tx, ResolutionContractInsert.parse({
      taskId: task.result.id, ...policy,
      metadata: { ...policy.metadata, agreementOfferId: offer.id, agreementObligationId: obligation.id },
    }), { tenantId: offer.workspaceId, actor, principalId, now });
    events.push(resolution.event);
    compilations.push({ obligationId: obligation.id, commitmentId: task.result.id, resolutionContractId: resolution.result.id });
  }
  const withoutDigest = {
    contractVersion: "tasq.agreement-activation.v1" as const,
    id: uuidv7(now), workspaceId: offer.workspaceId, offerId: offer.id,
    termsDigest: offer.termsDigest, acceptanceIds: acceptances.map(({ id }) => id).sort(),
    compilations, supersedesActivationId: supersedesActivation?.id ?? null, activatedAt: now,
  };
  const activation = AgreementActivationV1.parse({
    ...withoutDigest, activationDigest: agreementActivationDigest(withoutDigest),
  });
  await tx.insert(agreementActivation).values({
    id: activation.id, tenantId: offer.workspaceId, offerId: offer.id,
    termsDigest: activation.termsDigest, acceptanceIdsJson: canonicalJson(activation.acceptanceIds),
    compilationsJson: canonicalJson(activation.compilations),
    supersedesActivationId: activation.supersedesActivationId, activatedAt: now,
    activationDigest: activation.activationDigest,
  });
  return { activation, events };
}

export async function acceptAgreement(
  db: TasqDb,
  offerId: string,
  input: { termsDigest: string; metadata?: Metadata },
  ctx: ServiceContext = {},
): Promise<AgreementView> {
  const workspaceId = ctx.tenantId ?? "gwendall";
  const partyPrincipalId = authenticatedPrincipal(ctx);
  const now = serviceNow(ctx, ctx.now);
  const retry = prepareIdempotency({ ...ctx, tenantId: workspaceId }, "agreement.accept", {
    offerId, partyPrincipalId, termsDigest: input.termsDigest, metadata: input.metadata ?? {},
  }, { now });
  const { view, events } = await runInTransaction(db, async (tx) => {
    const prior = await findIdempotencyResult(tx, retry);
    if (prior) {
      const replay = await getAgreementView(tx, offerId, workspaceId, now);
      if (!replay) throw new Error(`idempotency record points at missing agreement ${offerId}`);
      return { view: replay, events: [] as Event[] };
    }
    const before = await getAgreementView(tx, offerId, workspaceId, now);
    if (!before) throw new Error("agreement offer not found in workspace");
    if (before.state !== "offered") throw new Error(`agreement offer is not open: ${before.state}`);
    if (before.offer.termsDigest !== input.termsDigest) throw new Error("acceptance terms digest does not match exact offer");
    if (!before.offer.terms.parties.some(({ principalId }) => principalId === partyPrincipalId)) {
      throw new Error("authenticated principal is not an agreement party");
    }
    const withoutDigest = {
      contractVersion: "tasq.agreement-acceptance.v1" as const,
      id: uuidv7(now), workspaceId, offerId, partyPrincipalId,
      termsDigest: before.offer.termsDigest, acceptedAt: now, metadata: input.metadata ?? {},
    };
    const acceptance = AgreementAcceptanceV1.parse({
      ...withoutDigest, acceptanceDigest: agreementAcceptanceDigest(withoutDigest),
    });
    await tx.insert(agreementAcceptance).values({
      id: acceptance.id, tenantId: workspaceId, offerId,
      partyPrincipalId, termsDigest: acceptance.termsDigest,
      acceptanceDigest: acceptance.acceptanceDigest, acceptedAt: now,
      metadataJson: canonicalJson(acceptance.metadata),
    });
    const acceptances = (await tx.select().from(agreementAcceptance).where(and(
      eq(agreementAcceptance.tenantId, workspaceId), eq(agreementAcceptance.offerId, offerId),
    )).orderBy(asc(agreementAcceptance.partyPrincipalId))).map(parseAcceptance);
    let events: Event[] = [];
    if (acceptances.length === before.offer.terms.parties.length) {
      const compiled = await compileActivation({
        tx, offer: before.offer, acceptances, actor: ctx.actor ?? "system",
        principalId: partyPrincipalId, now,
      });
      events = compiled.events;
    }
    await saveIdempotencyResult(tx, retry, {
      resultType: "agreement_acceptance", resultId: acceptance.id,
      resultStatus: acceptances.length === before.offer.terms.parties.length ? "accepted" : "partial",
    });
    const view = await getAgreementView(tx, offerId, workspaceId, now);
    if (!view) throw new Error("agreement disappeared after acceptance");
    return { view, events };
  });
  for (const event of events) emitAfterCommit(event);
  return view;
}

async function terminateAgreement(
  db: TasqDb,
  offerId: string,
  action: "withdrawn" | "rejected",
  input: { termsDigest: string; reason: string; metadata?: Metadata },
  ctx: ServiceContext,
): Promise<AgreementView> {
  const workspaceId = ctx.tenantId ?? "gwendall";
  const actorPrincipalId = authenticatedPrincipal(ctx);
  const now = serviceNow(ctx, ctx.now);
  const retry = prepareIdempotency({ ...ctx, tenantId: workspaceId }, `agreement.${action}`, {
    offerId, action, actorPrincipalId, ...input, metadata: input.metadata ?? {},
  }, { now });
  return runInTransaction(db, async (tx) => {
    const prior = await findIdempotencyResult(tx, retry);
    if (prior) {
      const replay = await getAgreementView(tx, offerId, workspaceId, now);
      if (!replay) throw new Error(`idempotency record points at missing agreement ${offerId}`);
      return replay;
    }
    const before = await getAgreementView(tx, offerId, workspaceId, now);
    if (!before) throw new Error("agreement offer not found in workspace");
    if (before.state !== "offered") throw new Error(`agreement offer is not open: ${before.state}`);
    if (before.offer.termsDigest !== input.termsDigest) throw new Error("termination terms digest does not match exact offer");
    if (action === "withdrawn" && before.offer.offerorPrincipalId !== actorPrincipalId) {
      throw new Error("only the authenticated offeror may withdraw an offer");
    }
    if (action === "rejected" && !before.offer.terms.parties.some(({ principalId }) => principalId === actorPrincipalId)) {
      throw new Error("only an agreement party may reject an offer");
    }
    const termination = AgreementTerminationV1.parse({
      contractVersion: "tasq.agreement-termination.v1", id: uuidv7(now), workspaceId,
      offerId, actorPrincipalId, action, termsDigest: before.offer.termsDigest,
      reason: input.reason, terminatedAt: now, metadata: input.metadata ?? {},
    });
    await tx.insert(agreementTermination).values({
      id: termination.id, tenantId: workspaceId, offerId, actorPrincipalId,
      action, termsDigest: termination.termsDigest, reason: termination.reason,
      terminatedAt: now, metadataJson: canonicalJson(termination.metadata),
    });
    await saveIdempotencyResult(tx, retry, {
      resultType: "agreement_termination", resultId: termination.id, resultStatus: action,
    });
    const result = await getAgreementView(tx, offerId, workspaceId, now);
    if (!result) throw new Error("agreement disappeared after termination");
    return result;
  });
}

export const withdrawAgreement = (
  db: TasqDb, offerId: string, input: { termsDigest: string; reason: string; metadata?: Metadata }, ctx: ServiceContext = {},
) => terminateAgreement(db, offerId, "withdrawn", input, ctx);

export const rejectAgreement = (
  db: TasqDb, offerId: string, input: { termsDigest: string; reason: string; metadata?: Metadata }, ctx: ServiceContext = {},
) => terminateAgreement(db, offerId, "rejected", input, ctx);

export const AGREEMENT_ACCEPTANCE_BINDER: TrustedStatementBinder = {
  descriptor: AGREEMENT_ACCEPTANCE_BINDER_DESCRIPTOR,
  async assertTarget({ tx, workspaceId, payload, binding }) {
    const rows = await tx.select().from(agreementAcceptance).where(and(
      eq(agreementAcceptance.tenantId, workspaceId), eq(agreementAcceptance.id, binding.recordId),
    )).limit(1);
    const row = rows[0];
    if (!row || payload.subject.id !== row.id || binding.recordDigest !== row.acceptanceDigest) {
      throw new Error("bound agreement acceptance digest not found");
    }
    if (payload.issuerPrincipalId !== row.partyPrincipalId) {
      throw new Error("agreement acceptance signer is not the accepting party");
    }
  },
};

export function agreementAcceptanceStatementBinding(record: Acceptance): SignedStatementBinderInput {
  return {
    bindingKind: "agreement_acceptance", recordType: "agreement_acceptance",
    recordId: record.id, recordDigest: record.acceptanceDigest,
    expectedBinder: AGREEMENT_ACCEPTANCE_BINDER_PIN,
  };
}
