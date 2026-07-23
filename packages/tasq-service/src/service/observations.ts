/** Immutable normalized observations submitted by watchers/connectors. */

import { and, asc, desc, eq, gt, gte, inArray, lte, or } from "drizzle-orm";
import {
  observation,
  observationRoute,
  Observation as ObservationZ,
  ObservationInsert,
  uuidv7,
  type Metadata,
  type Observation,
  type ObservationKind,
  type VerificationLevel,
  type Clock,
} from "@tasq-run/schema";
import { OBSERVATION_KIND_TYPE_URIS } from "@tasq-internal/reference-extension";
import type { TasqDb, TasqDbOrTx } from "../db.js";
import { runInTransaction } from "../db.js";
import { observationRouteKeys } from "./matchers.js";
import { ensureBundledReferenceExtensionAvailable } from "./reference-extensions.js";
import {
  deriveReferenceObservationSubjectRef,
  parseReferenceObservation,
} from "./reference-runtime.js";
import { serviceNow } from "../util/clock.js";

function validateUnixMs(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative unix-ms integer`);
  }
  return value;
}

function parseObservation(row: typeof observation.$inferSelect): Observation {
  return ObservationZ.parse({
    ...row,
    payload: JSON.parse(row.payload) as unknown,
    metadata: JSON.parse(row.metadata) as unknown,
  });
}

export interface IngestObservationOptions {
  actor?: string;
  tenantId?: string;
  /** Deterministic Tasq ingestion clock; never caller-controlled domain time. */
  now?: number;
  clock?: Clock;
}

/**
 * Ingest one provider delivery exactly once.
 *
 * The provider identity is stronger than a generic retry key: identical
 * re-delivery returns the original row, while changed meaningful content under
 * the same identity is rejected as a connector integrity error.
 */
export async function ingestObservation(
  db: TasqDb,
  input: unknown,
  options: IngestObservationOptions = {},
): Promise<Observation> {
  const parsed = ObservationInsert.parse(input);
  if (!parsed.source.trim()) throw new Error("Observation source must not be blank");
  if (!parsed.externalEventId.trim()) {
    throw new Error("Observation externalEventId must not be blank");
  }
  const tenantId = options.tenantId ?? parsed.tenantId;
  const recordedBy = options.actor ?? "system";
  if (!recordedBy.trim()) throw new Error("Observation actor must not be blank");
  const recordedAt = validateUnixMs(serviceNow(options, options.now), "now");
  const occurredAt = validateUnixMs(parsed.occurredAt, "occurredAt");
  const payload = parseReferenceObservation(parsed.kind, parsed.schemaVersion, parsed.payload);
  const subjectRef = deriveReferenceObservationSubjectRef(parsed.kind, parsed.schemaVersion, payload);
  await ensureBundledReferenceExtensionAvailable(db, {
    tenantId,
    actor: recordedBy,
    now: recordedAt,
  });
  const typeUri = OBSERVATION_KIND_TYPE_URIS[parsed.kind];
  const canonical = canonicalContent({
    tenantId,
    source: parsed.source,
    externalEventId: parsed.externalEventId,
    kind: parsed.kind,
    schemaVersion: parsed.schemaVersion,
    subjectRef,
    payload,
    occurredAt,
    verificationLevel: parsed.verificationLevel,
    verificationMethod: parsed.verificationMethod,
    rawRef: parsed.rawRef,
    digest: parsed.digest,
    metadata: parsed.metadata,
  });

  return runInTransaction(db, async (tx) => {
    const prior = await getObservationByDelivery(
      tx,
      parsed.source,
      parsed.externalEventId,
      tenantId,
    );
    if (prior) {
      if (stableSerialize(canonicalContent(prior)) !== stableSerialize(canonical)) {
        throw new Error(
          `Observation delivery identity reused with different content: ${parsed.source}/${parsed.externalEventId}`,
        );
      }
      return prior;
    }

    const id = parsed.id ?? uuidv7(recordedAt);
    await tx.insert(observation).values({
      id,
      tenantId,
      source: parsed.source,
      externalEventId: parsed.externalEventId,
      kind: parsed.kind,
      typeUri,
      schemaVersion: parsed.schemaVersion,
      subjectRef,
      payload: JSON.stringify(payload),
      occurredAt,
      recordedAt,
      recordedBy,
      verificationLevel: parsed.verificationLevel,
      verificationMethod: parsed.verificationMethod,
      rawRef: parsed.rawRef,
      digest: parsed.digest,
      metadata: JSON.stringify(parsed.metadata),
    });
    const inserted = await getObservation(tx, id, tenantId);
    if (!inserted) throw new Error(`Failed to read back observation ${id}`);
    for (const routeKey of observationRouteKeys(inserted)) {
      await tx.insert(observationRoute).values({
        observationId: id,
        tenantId,
        kind: inserted.kind,
        routeKey,
      });
    }
    return inserted;
  });
}

export async function getObservation(
  db: TasqDbOrTx,
  id: string,
  tenantId = "gwendall",
): Promise<Observation | null> {
  const rows = await db
    .select()
    .from(observation)
    .where(and(eq(observation.id, id), eq(observation.tenantId, tenantId)))
    .limit(1);
  return rows[0] ? parseObservation(rows[0]) : null;
}

export async function getObservationByDelivery(
  db: TasqDbOrTx,
  source: string,
  externalEventId: string,
  tenantId = "gwendall",
): Promise<Observation | null> {
  const rows = await db
    .select()
    .from(observation)
    .where(
      and(
        eq(observation.tenantId, tenantId),
        eq(observation.source, source),
        eq(observation.externalEventId, externalEventId),
      ),
    )
    .limit(1);
  return rows[0] ? parseObservation(rows[0]) : null;
}

export interface ListObservationsOptions {
  tenantId?: string;
  source?: string;
  kinds?: ObservationKind[];
  subjectRef?: string;
  verificationLevels?: VerificationLevel[];
  occurredFrom?: number;
  occurredTo?: number;
  /** Exclusive, lossless ingestion cursor for polling consumers. */
  after?: { recordedAt: number; id: string };
  ascending?: boolean;
  limit?: number;
}

export async function listObservations(
  db: TasqDb,
  options: ListObservationsOptions = {},
): Promise<Observation[]> {
  const filters = [eq(observation.tenantId, options.tenantId ?? "gwendall")];
  if (options.source) filters.push(eq(observation.source, options.source));
  if (options.kinds?.length) filters.push(inArray(observation.kind, options.kinds));
  if (options.subjectRef) filters.push(eq(observation.subjectRef, options.subjectRef));
  if (options.verificationLevels?.length) {
    filters.push(inArray(observation.verificationLevel, options.verificationLevels));
  }
  if (options.occurredFrom != null) {
    filters.push(gte(observation.occurredAt, validateUnixMs(options.occurredFrom, "occurredFrom")));
  }
  if (options.occurredTo != null) {
    filters.push(lte(observation.occurredAt, validateUnixMs(options.occurredTo, "occurredTo")));
  }
  if (options.after) {
    const recordedAt = validateUnixMs(options.after.recordedAt, "after.recordedAt");
    if (!options.after.id) throw new Error("after.id must not be empty");
    const cursorFilter = or(
      gt(observation.recordedAt, recordedAt),
      and(eq(observation.recordedAt, recordedAt), gt(observation.id, options.after.id)),
    );
    if (cursorFilter) filters.push(cursorFilter);
  }
  const ascending = options.after ? true : (options.ascending ?? false);
  const rows = await db
    .select()
    .from(observation)
    .where(and(...filters))
    .orderBy(
      (ascending ? asc : desc)(observation.recordedAt),
      (ascending ? asc : desc)(observation.id),
    )
    .limit(options.limit ?? 100);
  return rows.map(parseObservation);
}

interface CanonicalObservationContent {
  tenantId: string;
  source: string;
  externalEventId: string;
  kind: ObservationKind;
  schemaVersion: number;
  subjectRef: string;
  payload: Metadata;
  occurredAt: number;
  verificationLevel: VerificationLevel;
  verificationMethod: string | null;
  rawRef: string | null;
  digest: string | null;
  metadata: Metadata;
}

function canonicalContent(value: CanonicalObservationContent): CanonicalObservationContent;
function canonicalContent(value: Observation): CanonicalObservationContent;
function canonicalContent(
  value: CanonicalObservationContent | Observation,
): CanonicalObservationContent {
  return {
    tenantId: value.tenantId,
    source: value.source,
    externalEventId: value.externalEventId,
    kind: value.kind,
    schemaVersion: value.schemaVersion,
    subjectRef: value.subjectRef,
    payload: value.payload,
    occurredAt: value.occurredAt,
    verificationLevel: value.verificationLevel,
    verificationMethod: value.verificationMethod,
    rawRef: value.rawRef,
    digest: value.digest,
    metadata: value.metadata,
  };
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableSerialize(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
