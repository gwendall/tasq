import { createHash } from "node:crypto";
import { canonicalizeEffectJson, uuidv7, type Metadata } from "@tasq-run/schema";
import { recordCapturedEvidence, type TasqDb } from "@tasq-run/core";

export const CAPTURE_SESSION_VERSION = "tasq.evidence-capture-session.v1" as const;
export const CAPTURE_MANIFEST_VERSION = "tasq.evidence-capture-manifest.v1" as const;

type Digest = `sha256:${string}`;

export interface EvidenceCaptureSessionV1 {
  contractVersion: typeof CAPTURE_SESSION_VERSION;
  id: string;
  workspaceId: string;
  commitmentId: string;
  commitmentRevision: number;
  attemptId: string;
  resolutionContractId: string;
  criterionId: string;
  target: { typeUri: string; reference: string; digest: Digest };
  source: { kind: string; reference: string };
  bounds: { acceptedMediaTypes: string[]; maximumBytes: number };
  openedAt: number;
  expiresAt: number;
  sessionDigest: Digest;
}

export interface CaptureDisclosure {
  redactions: Array<{ method: string; scope: string; reason: string }>;
  original: { disposition: "retained" | "deleted" | "never_stored" | "unknown"; reference: string | null };
  retention: { policyUri: string; retainUntil: number | null };
  deletion: { policyUri: string; status: "not_requested" | "scheduled" | "confirmed" | "unknown"; effectiveAt: number | null };
}

export interface ImmutableObjectStore {
  put(input: { key: string; bytes: Uint8Array; mediaType: string }): Promise<{
    uri: string; digest: string; byteLength: number;
  }>;
}

export interface FinalizedCapture {
  manifest: Record<string, unknown> & { manifestDigest: Digest; artifactDigest: Digest };
  artifactId: string;
  evidenceId: string;
}

export type CaptureFailureCode =
  | "session_expired" | "media_type_denied" | "size_exceeded" | "source_time_invalid"
  | "storage_failed" | "storage_integrity_mismatch" | "ledger_rejected";

export type CaptureFinalizeResult =
  | { ok: true; value: FinalizedCapture }
  | { ok: false; failure: { code: CaptureFailureCode; stage: "validation" | "storage" | "ledger"; message: string } };

function digestBytes(bytes: Uint8Array): Digest {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function digestValue(domain: string, value: unknown): Digest {
  return digestBytes(Buffer.from(`${domain}\0${canonicalizeEffectJson(value)}`, "utf8"));
}

function requireUnixMs(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be non-negative unix-ms`);
}

/** Freeze every mutable selector before a device or worker starts capture. */
export function freezeCaptureSession(input: Omit<EvidenceCaptureSessionV1, "contractVersion" | "sessionDigest" | "id"> & { id?: string }): EvidenceCaptureSessionV1 {
  requireUnixMs(input.openedAt, "openedAt");
  requireUnixMs(input.expiresAt, "expiresAt");
  if (input.expiresAt <= input.openedAt) throw new Error("capture session must expire after it opens");
  if (!Number.isSafeInteger(input.commitmentRevision) || input.commitmentRevision < 1) throw new Error("commitmentRevision must be positive");
  if (!Number.isSafeInteger(input.bounds.maximumBytes) || input.bounds.maximumBytes < 1) throw new Error("maximumBytes must be positive");
  if (input.bounds.acceptedMediaTypes.length === 0) throw new Error("at least one media type is required");
  if (!/^sha256:[0-9a-f]{64}$/.test(input.target.digest)) throw new Error("target digest must be lowercase sha256");
  const withoutDigest = {
    contractVersion: CAPTURE_SESSION_VERSION,
    ...input,
    id: input.id ?? uuidv7(input.openedAt),
    bounds: { ...input.bounds, acceptedMediaTypes: [...new Set(input.bounds.acceptedMediaTypes)].sort() },
  };
  return Object.freeze({ ...withoutDigest, sessionDigest: digestValue("tasq.capture-session.v1", withoutDigest) });
}

/** Upload exact bytes, verify the immutable store response, then atomically bind Artifact + Evidence in Core. */
export async function finalizeCapture(input: {
  db: TasqDb;
  session: EvidenceCaptureSessionV1;
  bytes: Uint8Array;
  mediaType: string;
  name: string;
  observedAt: number;
  disclosure: CaptureDisclosure;
  store: ImmutableObjectStore;
  actor?: string;
  principalId?: string;
  idempotencyKey: string;
  now: number;
}): Promise<CaptureFinalizeResult> {
  const fail = (code: CaptureFailureCode, stage: "validation" | "storage" | "ledger", error: unknown): CaptureFinalizeResult => ({
    ok: false, failure: { code, stage, message: error instanceof Error ? error.message : String(error) },
  });
  const expectedSessionDigest = digestValue("tasq.capture-session.v1", (({ sessionDigest: _, ...rest }) => rest)(input.session));
  if (expectedSessionDigest !== input.session.sessionDigest) return fail("ledger_rejected", "validation", "capture session digest mismatch");
  if (input.now >= input.session.expiresAt) return fail("session_expired", "validation", "capture session expired");
  if (!input.session.bounds.acceptedMediaTypes.includes(input.mediaType)) return fail("media_type_denied", "validation", "media type denied");
  if (input.bytes.byteLength > input.session.bounds.maximumBytes) return fail("size_exceeded", "validation", "capture exceeds byte bound");
  if (!Number.isSafeInteger(input.observedAt) || input.observedAt < input.session.openedAt || input.observedAt > input.now) {
    return fail("source_time_invalid", "validation", "observedAt falls outside the capture window");
  }
  const artifactDigest = digestBytes(input.bytes);
  let stored: Awaited<ReturnType<ImmutableObjectStore["put"]>>;
  try {
    stored = await input.store.put({ key: `${input.session.id}/${artifactDigest.slice(7)}`, bytes: input.bytes.slice(), mediaType: input.mediaType });
  } catch (error) {
    return fail("storage_failed", "storage", error);
  }
  if (stored.digest !== artifactDigest || stored.byteLength !== input.bytes.byteLength) {
    return fail("storage_integrity_mismatch", "storage", "immutable store did not attest the exact input bytes");
  }
  const manifestWithoutDigest = {
    contractVersion: CAPTURE_MANIFEST_VERSION,
    sessionId: input.session.id,
    sessionDigest: input.session.sessionDigest,
    workspaceId: input.session.workspaceId,
    commitment: { id: input.session.commitmentId, revision: input.session.commitmentRevision },
    attemptId: input.session.attemptId,
    target: input.session.target,
    resolution: { contractId: input.session.resolutionContractId, criterionId: input.session.criterionId },
    source: input.session.source,
    observedAt: input.observedAt,
    finalizedAt: input.now,
    mediaType: input.mediaType,
    byteLength: input.bytes.byteLength,
    artifact: { uri: stored.uri, digest: artifactDigest },
    disclosure: input.disclosure,
  };
  const manifest = {
    ...manifestWithoutDigest,
    artifactDigest,
    manifestDigest: digestValue("tasq.capture-manifest.v1", manifestWithoutDigest),
  };
  try {
    const recorded = await recordCapturedEvidence(input.db, {
      commitmentId: input.session.commitmentId,
      expectedCommitmentRevision: input.session.commitmentRevision,
      attemptId: input.session.attemptId,
      resolutionContractId: input.session.resolutionContractId,
      criterionId: input.session.criterionId,
      artifact: {
        typeUri: "https://schemas.tasq.dev/artifacts/captured-evidence/v1", schemaVersion: 1,
        name: input.name, mediaType: input.mediaType, uri: stored.uri, digest: artifactDigest,
        inlineDataRef: null, metadata: { captureManifestDigest: manifest.manifestDigest },
      },
      evidence: {
        supersedesEvidenceId: null, kind: "captured_outcome", summary: input.name,
        uri: stored.uri, digest: artifactDigest, source: input.session.source.reference,
        observedAt: input.observedAt, metadata: { captureManifest: manifest as unknown as Metadata },
      },
      bindingMetadata: manifest as unknown as Metadata,
      idempotencyKey: input.idempotencyKey,
    }, {
      tenantId: input.session.workspaceId, actor: input.actor, principalId: input.principalId, now: input.now,
    });
    return { ok: true, value: { manifest, artifactId: recorded.artifact.id, evidenceId: recorded.evidence.id } };
  } catch (error) {
    return fail("ledger_rejected", "ledger", error);
  }
}
