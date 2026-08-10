import { createHash } from "node:crypto";
import { getAgreementView, inspectCommitment, type TasqDb } from "@tasq-run/core";
import { canonicalizeEffectJson } from "@tasq-run/schema";

type Digest = `sha256:${string}`;
export type ExternalEvidenceCategory = "authority" | "custody" | "raw_bytes";

export interface OutcomeExternalReference {
  category: ExternalEvidenceCategory;
  uri: string;
  digest: Digest;
  version: string | null;
}

export interface OutcomeOmission {
  category: ExternalEvidenceCategory | "agreement";
  reasonCode: string;
  explanation: string;
}

export interface OutcomeRecordReference {
  recordType: string;
  id: string;
  revision: number | null;
  digest: Digest;
  body: unknown;
}

export interface OutcomeBundleV1 {
  contractVersion: "tasq.outcome-bundle.v1";
  workspaceId: string;
  commitmentId: string;
  generatedAt: number;
  records: OutcomeRecordReference[];
  externalReferences: OutcomeExternalReference[];
  omissions: OutcomeOmission[];
  bundleDigest: Digest;
}

function digestBytes(bytes: Uint8Array): Digest {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function digestValue(domain: string, value: unknown): Digest {
  return digestBytes(Buffer.from(`${domain}\0${canonicalizeEffectJson(value)}`, "utf8"));
}

function asRecord(recordType: string, value: unknown): OutcomeRecordReference {
  if (!value || typeof value !== "object") throw new Error(`${recordType} record must be an object`);
  const body = value as { id?: unknown; revision?: unknown };
  if (typeof body.id !== "string" || !body.id) throw new Error(`${recordType} record requires id`);
  return {
    recordType,
    id: body.id,
    revision: typeof body.revision === "number" ? body.revision : null,
    digest: digestValue(`tasq.outcome-record.${recordType}.v1`, value),
    body: value,
  };
}

function exactRecords(snapshot: NonNullable<Awaited<ReturnType<typeof inspectCommitment>>>, agreement: unknown | null): OutcomeRecordReference[] {
  const agreementRecord = agreement && typeof agreement === "object" && "offer" in agreement
    ? [{ id: ((agreement as { offer: { id: string } }).offer.id), view: agreement }]
    : [];
  const groups: Array<[string, unknown[]]> = [
    ["commitment", [snapshot.commitment]],
    ["agreement", agreementRecord],
    ["assignment", snapshot.assignments],
    ["attempt", snapshot.attempts],
    ["artifact", snapshot.artifacts],
    ["evidence", snapshot.evidence],
    ["resolution_contract", snapshot.resolutionContracts],
    ["evidence_trust", snapshot.evidenceTrustRecords],
    ["completion_proposal", snapshot.completionProposals],
    ["completion_challenge", snapshot.completionChallenges],
    ["validation_decision", snapshot.validationDecisions],
    ["completion_record", snapshot.completionRecords],
    ["effect", snapshot.effects],
    ["effect_approval", snapshot.effectApprovals],
    ["effect_receipt", snapshot.effectReceipts],
  ];
  return groups.flatMap(([type, values]) => values.map((value) => asRecord(type, value)))
    .sort((a, b) => a.recordType.localeCompare(b.recordType) || a.id.localeCompare(b.id));
}

function validateDisclosures(references: OutcomeExternalReference[], omissions: OutcomeOmission[]): void {
  for (const category of ["authority", "custody", "raw_bytes"] as const) {
    if (!references.some((value) => value.category === category) && !omissions.some((value) => value.category === category)) {
      throw new Error(`outcome bundle must disclose ${category} reference or omission`);
    }
  }
  for (const reference of references) {
    if (!/^sha256:[0-9a-f]{64}$/.test(reference.digest)) throw new Error(`external ${reference.category} digest must be lowercase sha256`);
  }
}

/** Build a deterministic, self-contained projection over exact canonical record bodies. */
export async function buildOutcomeBundle(input: {
  db: TasqDb;
  workspaceId: string;
  commitmentId: string;
  generatedAt: number;
  externalReferences?: OutcomeExternalReference[];
  omissions?: OutcomeOmission[];
}): Promise<OutcomeBundleV1> {
  if (!Number.isSafeInteger(input.generatedAt) || input.generatedAt < 0) throw new Error("generatedAt must be non-negative unix-ms");
  const snapshot = await inspectCommitment(input.db, input.commitmentId, { workspaceId: input.workspaceId, now: input.generatedAt });
  if (!snapshot) throw new Error(`Commitment not found: ${input.commitmentId}`);
  const metadata = snapshot.commitment.metadata as Record<string, unknown>;
  const agreementOfferId = typeof metadata.agreementOfferId === "string" ? metadata.agreementOfferId : null;
  const omissions = [...(input.omissions ?? [])];
  let agreement: unknown | null = null;
  if (agreementOfferId) agreement = await getAgreementView(input.db, agreementOfferId, input.workspaceId, input.generatedAt);
  if (!agreement && !omissions.some((value) => value.category === "agreement")) {
    omissions.push({ category: "agreement", reasonCode: agreementOfferId ? "agreement_missing" : "not_agreement_compiled", explanation: "No exact agreement view was available for this commitment." });
  }
  const externalReferences = [...(input.externalReferences ?? [])]
    .sort((a, b) => a.category.localeCompare(b.category) || a.uri.localeCompare(b.uri));
  omissions.sort((a, b) => a.category.localeCompare(b.category) || a.reasonCode.localeCompare(b.reasonCode));
  validateDisclosures(externalReferences, omissions);
  const withoutDigest = {
    contractVersion: "tasq.outcome-bundle.v1" as const,
    workspaceId: input.workspaceId,
    commitmentId: input.commitmentId,
    generatedAt: input.generatedAt,
    records: exactRecords(snapshot, agreement),
    externalReferences,
    omissions,
  };
  return { ...withoutDigest, bundleDigest: digestValue("tasq.outcome-bundle.v1", withoutDigest) };
}

export interface OutcomeBundleFreshness {
  outcome: "current" | "stale" | "missing" | "invalid";
  invalidBundleDigest: boolean;
  stale: Array<{ recordType: string; id: string; expectedDigest: Digest; currentDigest: Digest }>;
  missing: Array<{ recordType: string; id: string }>;
}

/** Re-read Core and distinguish changed records from records that disappeared. */
export async function verifyOutcomeBundleFreshness(db: TasqDb, bundle: OutcomeBundleV1): Promise<OutcomeBundleFreshness> {
  const { bundleDigest, ...withoutDigest } = bundle;
  const invalidBundleDigest = digestValue("tasq.outcome-bundle.v1", withoutDigest) !== bundleDigest;
  if (invalidBundleDigest) return { outcome: "invalid", invalidBundleDigest, stale: [], missing: [] };
  const snapshot = await inspectCommitment(db, bundle.commitmentId, { workspaceId: bundle.workspaceId, now: bundle.generatedAt });
  if (!snapshot) return {
    outcome: "missing", invalidBundleDigest: false, stale: [],
    missing: bundle.records.map(({ recordType, id }) => ({ recordType, id })),
  };
  const agreementRef = bundle.records.find(({ recordType }) => recordType === "agreement");
  const agreement = agreementRef ? await getAgreementView(db, agreementRef.id, bundle.workspaceId, bundle.generatedAt) : null;
  const current = new Map(exactRecords(snapshot, agreement).map((record) => [`${record.recordType}:${record.id}`, record]));
  const stale: OutcomeBundleFreshness["stale"] = [];
  const missing: OutcomeBundleFreshness["missing"] = [];
  for (const record of bundle.records) {
    const found = current.get(`${record.recordType}:${record.id}`);
    if (!found) missing.push({ recordType: record.recordType, id: record.id });
    else if (found.digest !== record.digest) stale.push({ recordType: record.recordType, id: record.id, expectedDigest: record.digest, currentDigest: found.digest });
  }
  return { outcome: missing.length ? "missing" : stale.length ? "stale" : "current", invalidBundleDigest: false, stale, missing };
}

export interface OutcomeBundleSigner {
  keyId: string;
  sign(bytes: Uint8Array): Promise<Uint8Array> | Uint8Array;
}

export interface SignedOutcomeBundleV1 {
  contractVersion: "tasq.signed-outcome-bundle.v1";
  payloadType: "application/vnd.tasq.outcome-bundle.v1+json";
  payload: string;
  payloadDigest: Digest;
  keyId: string;
  signature: string;
  assurance: "signature_authenticates_exact_bundle_bytes_not_real_world_truth";
}

export function serializeOutcomeBundle(bundle: OutcomeBundleV1): Uint8Array {
  return Buffer.from(canonicalizeEffectJson(bundle), "utf8");
}

/** Sign exact canonical bytes; the envelope makes no semantic/outcome claim. */
export async function signOutcomeBundle(bundle: OutcomeBundleV1, signer: OutcomeBundleSigner): Promise<SignedOutcomeBundleV1> {
  const payload = serializeOutcomeBundle(bundle);
  const signature = await signer.sign(payload.slice());
  if (signature.byteLength === 0) throw new Error("empty outcome bundle signature");
  return {
    contractVersion: "tasq.signed-outcome-bundle.v1",
    payloadType: "application/vnd.tasq.outcome-bundle.v1+json",
    payload: Buffer.from(payload).toString("base64url"),
    payloadDigest: digestBytes(payload),
    keyId: signer.keyId,
    signature: Buffer.from(signature).toString("base64url"),
    assurance: "signature_authenticates_exact_bundle_bytes_not_real_world_truth",
  };
}

export async function verifySignedOutcomeBundle(input: {
  envelope: SignedOutcomeBundleV1;
  verify(keyId: string, bytes: Uint8Array, signature: Uint8Array): Promise<boolean> | boolean;
}): Promise<{ outcome: "valid" | "invalid"; reasonCode: string; bundle: OutcomeBundleV1 | null }> {
  let payload: Uint8Array;
  let signature: Uint8Array;
  try {
    payload = Buffer.from(input.envelope.payload, "base64url");
    signature = Buffer.from(input.envelope.signature, "base64url");
    if (Buffer.from(payload).toString("base64url") !== input.envelope.payload) throw new Error("noncanonical payload encoding");
    if (digestBytes(payload) !== input.envelope.payloadDigest) throw new Error("payload digest mismatch");
  } catch {
    return { outcome: "invalid", reasonCode: "envelope_integrity_failed", bundle: null };
  }
  if (!(await input.verify(input.envelope.keyId, payload.slice(), signature.slice()))) {
    return { outcome: "invalid", reasonCode: "signature_invalid", bundle: null };
  }
  try {
    const text = Buffer.from(payload).toString("utf8");
    const bundle = JSON.parse(text) as OutcomeBundleV1;
    if (canonicalizeEffectJson(bundle) !== text) throw new Error("noncanonical bundle");
    return { outcome: "valid", reasonCode: "exact_bundle_bytes_authenticated", bundle };
  } catch {
    return { outcome: "invalid", reasonCode: "payload_invalid", bundle: null };
  }
}
