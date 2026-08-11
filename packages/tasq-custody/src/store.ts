import { createClient, type Client, type Transaction } from "@libsql/client";
import {
  canonicalizeEffectJson,
  prepareTargetRefV1,
  uuidv7,
  type Clock,
  type TargetRefV1,
} from "@tasq-run/schema";
import {
  CUSTODY_MODULE_VERSION,
  CUSTODY_PORTABLE_VERSION,
  CustodyHandoffV1,
  CustodyIncidentV1,
  CustodyStateV1,
  CustodyTargetV1,
  Digest,
  custodyDigest,
  type CustodyCurrentViewV1,
  type CustodyMutationContext,
  type CustodyPortableV1,
  type CustodyStateV1 as State,
  type CustodyHandoffV1 as Handoff,
  type CustodyIncidentV1 as Incident,
  type CustodyTargetV1 as Target,
} from "./types.js";

const migration = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS experimental_custody_target (
  workspace_id TEXT NOT NULL,
  target_digest TEXT NOT NULL,
  target_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(workspace_id, target_digest)
);
CREATE TABLE IF NOT EXISTS experimental_custody_state (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  target_digest TEXT NOT NULL,
  custodian_principal_id TEXT NOT NULL,
  predecessor_state_id TEXT,
  accepted_handoff_id TEXT,
  condition_json TEXT NOT NULL,
  condition_digest TEXT NOT NULL,
  evidence_refs_json TEXT NOT NULL,
  effective_at INTEGER NOT NULL,
  recorded_at INTEGER NOT NULL,
  CHECK((predecessor_state_id IS NULL AND accepted_handoff_id IS NULL)
    OR (predecessor_state_id IS NOT NULL AND accepted_handoff_id IS NOT NULL)),
  UNIQUE(workspace_id, id),
  FOREIGN KEY(workspace_id, target_digest) REFERENCES experimental_custody_target(workspace_id, target_digest),
  FOREIGN KEY(workspace_id, predecessor_state_id) REFERENCES experimental_custody_state(workspace_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS experimental_custody_one_root
  ON experimental_custody_state(workspace_id, target_digest) WHERE predecessor_state_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS experimental_custody_one_successor
  ON experimental_custody_state(workspace_id, predecessor_state_id) WHERE predecessor_state_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS experimental_custody_handoff (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  target_digest TEXT NOT NULL,
  source_state_id TEXT NOT NULL,
  from_principal_id TEXT NOT NULL,
  to_principal_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('offered','accepted','refused')),
  condition_json TEXT NOT NULL,
  condition_digest TEXT NOT NULL,
  evidence_requirements_json TEXT NOT NULL,
  acceptance_evidence_json TEXT NOT NULL,
  offered_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  decided_at INTEGER,
  refusal_reason TEXT,
  revision INTEGER NOT NULL,
  CHECK(from_principal_id != to_principal_id),
  CHECK(expires_at > offered_at),
  CHECK((status = 'offered' AND decided_at IS NULL AND refusal_reason IS NULL
      AND acceptance_evidence_json = '[]' AND revision = 1)
    OR (status = 'accepted' AND decided_at IS NOT NULL AND refusal_reason IS NULL
      AND acceptance_evidence_json != '[]' AND revision = 2)
    OR (status = 'refused' AND decided_at IS NOT NULL AND refusal_reason IS NOT NULL
      AND acceptance_evidence_json = '[]' AND revision = 2)),
  UNIQUE(workspace_id, id),
  FOREIGN KEY(workspace_id, target_digest) REFERENCES experimental_custody_target(workspace_id, target_digest),
  FOREIGN KEY(workspace_id, source_state_id) REFERENCES experimental_custody_state(workspace_id, id)
);
CREATE TABLE IF NOT EXISTS experimental_custody_incident (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  target_digest TEXT NOT NULL,
  state_id TEXT NOT NULL,
  reporter_principal_id TEXT NOT NULL,
  kind_uri TEXT NOT NULL,
  summary TEXT NOT NULL,
  evidence_refs_json TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  recorded_at INTEGER NOT NULL,
  UNIQUE(workspace_id, id),
  FOREIGN KEY(workspace_id, target_digest) REFERENCES experimental_custody_target(workspace_id, target_digest),
  FOREIGN KEY(workspace_id, state_id) REFERENCES experimental_custody_state(workspace_id, id)
);
CREATE TABLE IF NOT EXISTS experimental_custody_idempotency (
  workspace_id TEXT NOT NULL,
  actor_principal_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  result_type TEXT NOT NULL,
  result_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(workspace_id, actor_principal_id, operation, idempotency_key)
);
CREATE TABLE IF NOT EXISTS experimental_custody_event (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  target_digest TEXT NOT NULL,
  actor_principal_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  record_type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  recorded_at INTEGER NOT NULL
);
CREATE TRIGGER IF NOT EXISTS experimental_custody_target_no_update BEFORE UPDATE ON experimental_custody_target
BEGIN SELECT RAISE(ABORT, 'custody targets are immutable'); END;
CREATE TRIGGER IF NOT EXISTS experimental_custody_target_no_delete BEFORE DELETE ON experimental_custody_target
BEGIN SELECT RAISE(ABORT, 'custody targets are append-only'); END;
CREATE TRIGGER IF NOT EXISTS experimental_custody_state_no_update BEFORE UPDATE ON experimental_custody_state
BEGIN SELECT RAISE(ABORT, 'custody states are immutable'); END;
CREATE TRIGGER IF NOT EXISTS experimental_custody_state_no_delete BEFORE DELETE ON experimental_custody_state
BEGIN SELECT RAISE(ABORT, 'custody states are append-only'); END;
CREATE TRIGGER IF NOT EXISTS experimental_custody_incident_no_update BEFORE UPDATE ON experimental_custody_incident
BEGIN SELECT RAISE(ABORT, 'custody incidents are immutable'); END;
CREATE TRIGGER IF NOT EXISTS experimental_custody_incident_no_delete BEFORE DELETE ON experimental_custody_incident
BEGIN SELECT RAISE(ABORT, 'custody incidents are append-only'); END;
CREATE TRIGGER IF NOT EXISTS experimental_custody_event_no_update BEFORE UPDATE ON experimental_custody_event
BEGIN SELECT RAISE(ABORT, 'custody events are immutable'); END;
CREATE TRIGGER IF NOT EXISTS experimental_custody_event_no_delete BEFORE DELETE ON experimental_custody_event
BEGIN SELECT RAISE(ABORT, 'custody events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS experimental_custody_handoff_guard BEFORE UPDATE ON experimental_custody_handoff
WHEN OLD.status != 'offered'
  OR NEW.status NOT IN ('accepted','refused')
  OR NEW.revision != OLD.revision + 1
  OR NEW.id != OLD.id OR NEW.workspace_id != OLD.workspace_id OR NEW.target_digest != OLD.target_digest
  OR NEW.source_state_id != OLD.source_state_id OR NEW.from_principal_id != OLD.from_principal_id
  OR NEW.to_principal_id != OLD.to_principal_id OR NEW.condition_json != OLD.condition_json
  OR NEW.condition_digest != OLD.condition_digest
  OR NEW.evidence_requirements_json != OLD.evidence_requirements_json
  OR NEW.offered_at != OLD.offered_at OR NEW.expires_at != OLD.expires_at
  OR NEW.decided_at IS NULL
  OR (NEW.status = 'accepted' AND (NEW.refusal_reason IS NOT NULL OR NEW.acceptance_evidence_json = '[]'))
  OR (NEW.status = 'refused' AND (NEW.refusal_reason IS NULL OR NEW.acceptance_evidence_json != '[]'))
BEGIN SELECT RAISE(ABORT, 'invalid custody handoff transition'); END;
CREATE TRIGGER IF NOT EXISTS experimental_custody_handoff_no_delete BEFORE DELETE ON experimental_custody_handoff
BEGIN SELECT RAISE(ABORT, 'custody handoffs are append-only'); END;
CREATE TRIGGER IF NOT EXISTS experimental_custody_idempotency_no_update BEFORE UPDATE ON experimental_custody_idempotency
BEGIN SELECT RAISE(ABORT, 'custody idempotency is immutable'); END;
CREATE TRIGGER IF NOT EXISTS experimental_custody_idempotency_no_delete BEFORE DELETE ON experimental_custody_idempotency
BEGIN SELECT RAISE(ABORT, 'custody idempotency is append-only'); END;
`;

function required(value: string, label: string): string {
  const parsed = value.trim();
  if (!parsed || parsed.length > 500) throw new Error(`${label} must be a non-blank portable identifier`);
  return parsed;
}

function unixMs(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be non-negative unix-ms`);
  return value;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
  return value;
}

function digest(value: string, label: string): string {
  const parsed = Digest.safeParse(value);
  if (!parsed.success) throw new Error(`${label} must be a sha256 digest`);
  return parsed.data;
}

function stringValue(row: Record<string, unknown>, key: string): string {
  if (typeof row[key] !== "string") throw new Error(`corrupt custody ${key}`);
  return row[key] as string;
}

function integerValue(row: Record<string, unknown>, key: string): number {
  const value = Number(row[key]);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`corrupt custody ${key}`);
  return value;
}

function parseTarget(row: Record<string, unknown>): Target {
  return CustodyTargetV1.parse({
    contractVersion: CUSTODY_MODULE_VERSION,
    workspaceId: stringValue(row, "workspace_id"), targetDigest: stringValue(row, "target_digest"),
    target: JSON.parse(stringValue(row, "target_json")), createdAt: integerValue(row, "created_at"),
  });
}

function parseState(row: Record<string, unknown>): State {
  return CustodyStateV1.parse({
    contractVersion: CUSTODY_MODULE_VERSION,
    id: stringValue(row, "id"), workspaceId: stringValue(row, "workspace_id"),
    targetDigest: stringValue(row, "target_digest"), custodianPrincipalId: stringValue(row, "custodian_principal_id"),
    predecessorStateId: row["predecessor_state_id"] == null ? null : stringValue(row, "predecessor_state_id"),
    acceptedHandoffId: row["accepted_handoff_id"] == null ? null : stringValue(row, "accepted_handoff_id"),
    condition: JSON.parse(stringValue(row, "condition_json")), conditionDigest: stringValue(row, "condition_digest"),
    evidenceRefs: JSON.parse(stringValue(row, "evidence_refs_json")), effectiveAt: integerValue(row, "effective_at"),
    recordedAt: integerValue(row, "recorded_at"),
  });
}

function parseHandoff(row: Record<string, unknown>): Handoff {
  return CustodyHandoffV1.parse({
    contractVersion: CUSTODY_MODULE_VERSION,
    id: stringValue(row, "id"), workspaceId: stringValue(row, "workspace_id"),
    targetDigest: stringValue(row, "target_digest"), sourceStateId: stringValue(row, "source_state_id"),
    fromPrincipalId: stringValue(row, "from_principal_id"), toPrincipalId: stringValue(row, "to_principal_id"),
    status: stringValue(row, "status"), condition: JSON.parse(stringValue(row, "condition_json")),
    conditionDigest: stringValue(row, "condition_digest"),
    evidenceRequirements: JSON.parse(stringValue(row, "evidence_requirements_json")),
    acceptanceEvidence: JSON.parse(stringValue(row, "acceptance_evidence_json")),
    offeredAt: integerValue(row, "offered_at"), expiresAt: integerValue(row, "expires_at"),
    decidedAt: row["decided_at"] == null ? null : integerValue(row, "decided_at"),
    refusalReason: row["refusal_reason"] == null ? null : stringValue(row, "refusal_reason"),
    revision: integerValue(row, "revision"),
  });
}

function parseIncident(row: Record<string, unknown>): Incident {
  return CustodyIncidentV1.parse({
    contractVersion: CUSTODY_MODULE_VERSION,
    id: stringValue(row, "id"), workspaceId: stringValue(row, "workspace_id"),
    targetDigest: stringValue(row, "target_digest"), stateId: stringValue(row, "state_id"),
    reporterPrincipalId: stringValue(row, "reporter_principal_id"), kindUri: stringValue(row, "kind_uri"),
    summary: stringValue(row, "summary"), evidenceRefs: JSON.parse(stringValue(row, "evidence_refs_json")),
    occurredAt: integerValue(row, "occurred_at"), recordedAt: integerValue(row, "recorded_at"),
  });
}

function refs(values: string[], label: string, requireOne = false): string[] {
  const result = [...new Set(values.map((value) => required(value, label)))].sort();
  if (requireOne && result.length === 0) throw new Error(`${label} requires at least one reference`);
  if (result.length > 100) throw new Error(`${label} exceeds 100 references`);
  return result;
}

function context(input: CustodyMutationContext): CustodyMutationContext {
  return {
    workspaceId: required(input.workspaceId, "workspaceId"),
    actorPrincipalId: required(input.actorPrincipalId, "actorPrincipalId"),
    idempotencyKey: required(input.idempotencyKey, "idempotencyKey"),
  };
}

type Replay = { resultType: string; resultId: string };

async function replay(tx: Transaction, ctx: CustodyMutationContext, operation: string, requestDigest: string): Promise<Replay | null> {
  const result = await tx.execute({
    sql: `SELECT request_digest, result_type, result_id FROM experimental_custody_idempotency
      WHERE workspace_id = ? AND actor_principal_id = ? AND operation = ? AND idempotency_key = ?`,
    args: [ctx.workspaceId, ctx.actorPrincipalId, operation, ctx.idempotencyKey],
  });
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  if (stringValue(row, "request_digest") !== requestDigest) throw new Error("custody idempotency key reused with different input");
  return { resultType: stringValue(row, "result_type"), resultId: stringValue(row, "result_id") };
}

async function saveReplay(tx: Transaction, ctx: CustodyMutationContext, operation: string, requestDigest: string, resultType: string, resultId: string, now: number) {
  await tx.execute({
    sql: `INSERT INTO experimental_custody_idempotency(
      workspace_id, actor_principal_id, operation, idempotency_key, request_digest, result_type, result_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [ctx.workspaceId, ctx.actorPrincipalId, operation, ctx.idempotencyKey, requestDigest, resultType, resultId, now],
  });
}

async function event(tx: Transaction, input: {
  workspaceId: string; targetDigest: string; actorPrincipalId: string; eventType: string;
  recordType: string; recordId: string; payload: unknown; now: number;
}) {
  await tx.execute({
    sql: `INSERT INTO experimental_custody_event(
      id, workspace_id, target_digest, actor_principal_id, event_type, record_type, record_id, payload_json, recorded_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [uuidv7(input.now), input.workspaceId, input.targetDigest, input.actorPrincipalId, input.eventType,
      input.recordType, input.recordId, canonicalizeEffectJson(input.payload), input.now],
  });
}

async function stateById(executor: Client | Transaction, workspaceId: string, id: string): Promise<State | null> {
  const result = await executor.execute({
    sql: "SELECT * FROM experimental_custody_state WHERE workspace_id = ? AND id = ?",
    args: [workspaceId, id],
  });
  return result.rows[0] ? parseState(result.rows[0] as Record<string, unknown>) : null;
}

async function handoffById(executor: Client | Transaction, workspaceId: string, id: string): Promise<Handoff | null> {
  const result = await executor.execute({
    sql: "SELECT * FROM experimental_custody_handoff WHERE workspace_id = ? AND id = ?",
    args: [workspaceId, id],
  });
  return result.rows[0] ? parseHandoff(result.rows[0] as Record<string, unknown>) : null;
}

export class ExperimentalCustodyStore {
  private writeTail: Promise<void> = Promise.resolve();

  private constructor(private readonly client: Client, private readonly clock: Clock) {}

  static async open(options: { url: string; clock: Clock; busyTimeoutMs?: number }): Promise<ExperimentalCustodyStore> {
    if (!options.clock || typeof options.clock.now !== "function") throw new Error("custody store requires an injected Clock");
    const busyTimeoutMs = options.busyTimeoutMs ?? 5_000;
    if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 1 || busyTimeoutMs > 30_000) {
      throw new Error("custody busyTimeoutMs must be an integer from 1 to 30000");
    }
    const client = createClient({ url: options.url });
    await client.execute("PRAGMA foreign_keys = ON");
    await client.execute(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
    await client.executeMultiple(migration);
    return new ExperimentalCustodyStore(client, options.clock);
  }

  close(): void { this.client.close(); }

  private now(): number { return unixMs(this.clock.now(), "clock"); }

  private async write<T>(fn: (tx: Transaction, now: number) => Promise<T>): Promise<T> {
    const previous = this.writeTail;
    let release!: () => void;
    this.writeTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    let tx: Transaction | null = null;
    try {
      const now = this.now();
      tx = await this.client.transaction("write");
      const result = await fn(tx, now);
      await tx.commit();
      return result;
    } catch (error) {
      if (tx) await tx.rollback();
      throw error;
    } finally {
      release();
    }
  }

  async getState(workspaceId: string, id: string): Promise<State | null> {
    return stateById(this.client, required(workspaceId, "workspaceId"), required(id, "stateId"));
  }

  async getHandoff(workspaceId: string, id: string): Promise<Handoff | null> {
    return handoffById(this.client, required(workspaceId, "workspaceId"), required(id, "handoffId"));
  }

  async establish(input: {
    target: TargetRefV1; custodianPrincipalId: string; condition: Record<string, unknown>;
    evidenceRefs: string[]; effectiveAt: number;
  }, contextInput: CustodyMutationContext): Promise<State> {
    const ctx = context(contextInput);
    const prepared = prepareTargetRefV1(input.target);
    const custodianPrincipalId = required(input.custodianPrincipalId, "custodianPrincipalId");
    if (ctx.actorPrincipalId !== custodianPrincipalId) throw new Error("initial custodian must establish their own custody assertion");
    const evidenceRefs = refs(input.evidenceRefs, "evidenceRefs", true);
    const conditionJson = canonicalizeEffectJson(input.condition);
    const condition = JSON.parse(conditionJson) as Record<string, unknown>;
    const conditionDigest = custodyDigest("tasq.custody-condition.v1", condition);
    const effectiveAt = unixMs(input.effectiveAt, "effectiveAt");
    const requestDigest = custodyDigest("tasq.custody.establish.v1", { prepared, custodianPrincipalId, condition, evidenceRefs, effectiveAt });
    return this.write(async (tx, now) => {
      const prior = await replay(tx, ctx, "establish", requestDigest);
      if (prior) {
        if (prior.resultType !== "state") throw new Error("custody replay type mismatch");
        const found = await stateById(tx, ctx.workspaceId, prior.resultId);
        if (!found) throw new Error("custody replay state missing");
        return found;
      }
      if (effectiveAt > now) throw new Error("custody effectiveAt cannot be in the future");
      await tx.execute({
        sql: "INSERT INTO experimental_custody_target(workspace_id, target_digest, target_json, created_at) VALUES (?, ?, ?, ?)",
        args: [ctx.workspaceId, prepared.targetDigest, prepared.canonicalTarget, now],
      });
      const id = uuidv7(now);
      await tx.execute({
        sql: `INSERT INTO experimental_custody_state(
          id, workspace_id, target_digest, custodian_principal_id, predecessor_state_id, accepted_handoff_id,
          condition_json, condition_digest, evidence_refs_json, effective_at, recorded_at
        ) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?)`,
        args: [id, ctx.workspaceId, prepared.targetDigest, custodianPrincipalId, conditionJson, conditionDigest,
          canonicalizeEffectJson(evidenceRefs), effectiveAt, now],
      });
      await event(tx, { workspaceId: ctx.workspaceId, targetDigest: prepared.targetDigest, actorPrincipalId: ctx.actorPrincipalId,
        eventType: "custody_established", recordType: "custody_state", recordId: id,
        payload: { custodianPrincipalId, conditionDigest, evidenceRefs }, now });
      await saveReplay(tx, ctx, "establish", requestDigest, "state", id, now);
      return (await stateById(tx, ctx.workspaceId, id))!;
    });
  }

  async offer(input: {
    targetDigest: string; sourceStateId: string; toPrincipalId: string;
    condition: Record<string, unknown>; evidenceRequirements: string[]; expiresAt: number;
  }, contextInput: CustodyMutationContext): Promise<Handoff> {
    const ctx = context(contextInput);
    const targetDigest = digest(input.targetDigest, "targetDigest");
    const sourceStateId = required(input.sourceStateId, "sourceStateId");
    const toPrincipalId = required(input.toPrincipalId, "toPrincipalId");
    if (toPrincipalId === ctx.actorPrincipalId) throw new Error("custody handoff requires two distinct principals");
    const conditionJson = canonicalizeEffectJson(input.condition);
    const condition = JSON.parse(conditionJson) as Record<string, unknown>;
    const conditionDigest = custodyDigest("tasq.custody-condition.v1", condition);
    const evidenceRequirements = refs(input.evidenceRequirements, "evidenceRequirements", true);
    const expiresAt = unixMs(input.expiresAt, "expiresAt");
    const requestDigest = custodyDigest("tasq.custody.offer.v1", { targetDigest, sourceStateId, toPrincipalId, condition, evidenceRequirements, expiresAt });
    return this.write(async (tx, now) => {
      const prior = await replay(tx, ctx, "offer", requestDigest);
      if (prior) {
        const found = await handoffById(tx, ctx.workspaceId, prior.resultId);
        if (!found) throw new Error("custody replay handoff missing");
        return found;
      }
      if (expiresAt <= now) throw new Error("custody handoff expiry must be in the future");
      const source = await stateById(tx, ctx.workspaceId, sourceStateId);
      if (!source || source.targetDigest !== targetDigest) throw new Error("custody source state not found for target");
      if (source.custodianPrincipalId !== ctx.actorPrincipalId) throw new Error("only the recorded current custodian may offer handoff");
      const successor = await tx.execute({
        sql: "SELECT id FROM experimental_custody_state WHERE workspace_id = ? AND predecessor_state_id = ? LIMIT 1",
        args: [ctx.workspaceId, sourceStateId],
      });
      if (successor.rows[0]) throw new Error("custody source state is no longer current");
      const id = uuidv7(now);
      await tx.execute({
        sql: `INSERT INTO experimental_custody_handoff(
          id, workspace_id, target_digest, source_state_id, from_principal_id, to_principal_id, status,
          condition_json, condition_digest, evidence_requirements_json, acceptance_evidence_json,
          offered_at, expires_at, decided_at, refusal_reason, revision
        ) VALUES (?, ?, ?, ?, ?, ?, 'offered', ?, ?, ?, '[]', ?, ?, NULL, NULL, 1)`,
        args: [id, ctx.workspaceId, targetDigest, sourceStateId, ctx.actorPrincipalId, toPrincipalId,
          conditionJson, conditionDigest, canonicalizeEffectJson(evidenceRequirements), now, expiresAt],
      });
      await event(tx, { workspaceId: ctx.workspaceId, targetDigest, actorPrincipalId: ctx.actorPrincipalId,
        eventType: "custody_handoff_offered", recordType: "custody_handoff", recordId: id,
        payload: { sourceStateId, fromPrincipalId: ctx.actorPrincipalId, toPrincipalId, conditionDigest }, now });
      await saveReplay(tx, ctx, "offer", requestDigest, "handoff", id, now);
      return (await handoffById(tx, ctx.workspaceId, id))!;
    });
  }

  async accept(handoffIdInput: string, input: {
    expectedRevision: number; conditionDigest: string;
    acceptanceEvidence: Array<{ requirement: string; evidenceRef: string }>;
    effectiveAt: number;
  }, contextInput: CustodyMutationContext): Promise<{ handoff: Handoff; state: State }> {
    const ctx = context(contextInput);
    const handoffId = required(handoffIdInput, "handoffId");
    const expectedRevision = positiveInteger(input.expectedRevision, "expectedRevision");
    const conditionDigest = digest(input.conditionDigest, "conditionDigest");
    const effectiveAt = unixMs(input.effectiveAt, "effectiveAt");
    const acceptanceEvidence = input.acceptanceEvidence.map((entry) => ({
      requirement: required(entry.requirement, "acceptanceEvidence.requirement"),
      evidenceRef: required(entry.evidenceRef, "acceptanceEvidence.evidenceRef"),
    })).sort((a, b) => a.requirement.localeCompare(b.requirement) || a.evidenceRef.localeCompare(b.evidenceRef));
    if (new Set(acceptanceEvidence.map((entry) => `${entry.requirement}\0${entry.evidenceRef}`)).size !== acceptanceEvidence.length) {
      throw new Error("duplicate custody acceptance evidence");
    }
    const requestDigest = custodyDigest("tasq.custody.accept.v1", { handoffId, expectedRevision, conditionDigest, acceptanceEvidence, effectiveAt });
    return this.write(async (tx, now) => {
      const prior = await replay(tx, ctx, "accept", requestDigest);
      if (prior) {
        const state = await stateById(tx, ctx.workspaceId, prior.resultId);
        const handoff = await handoffById(tx, ctx.workspaceId, handoffId);
        if (!state || !handoff) throw new Error("custody acceptance replay missing");
        return { handoff, state };
      }
      const handoff = await handoffById(tx, ctx.workspaceId, handoffId);
      if (!handoff) throw new Error("custody handoff not found");
      if (handoff.status !== "offered") throw new Error(`custody handoff is ${handoff.status}`);
      if (handoff.revision !== expectedRevision) throw new Error("custody handoff revision conflict");
      if (handoff.toPrincipalId !== ctx.actorPrincipalId) throw new Error("only the proposed recipient may accept custody");
      if (now >= handoff.expiresAt) throw new Error("custody handoff expired");
      if (effectiveAt > now) throw new Error("custody effectiveAt cannot be in the future");
      if (conditionDigest !== handoff.conditionDigest) throw new Error("custody condition digest drift");
      const requiredEvidence = new Set(handoff.evidenceRequirements);
      const supplied = new Set(acceptanceEvidence.map(({ requirement }) => requirement));
      if (requiredEvidence.size !== supplied.size || [...requiredEvidence].some((value) => !supplied.has(value))) {
        throw new Error("custody acceptance evidence does not cover exact requirements");
      }
      const source = await stateById(tx, ctx.workspaceId, handoff.sourceStateId);
      if (!source) throw new Error("custody source state missing");
      const stateId = uuidv7(now);
      await tx.execute({
        sql: `INSERT INTO experimental_custody_state(
          id, workspace_id, target_digest, custodian_principal_id, predecessor_state_id, accepted_handoff_id,
          condition_json, condition_digest, evidence_refs_json, effective_at, recorded_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [stateId, ctx.workspaceId, handoff.targetDigest, handoff.toPrincipalId, handoff.sourceStateId,
          handoff.id, canonicalizeEffectJson(handoff.condition), handoff.conditionDigest,
          canonicalizeEffectJson([...new Set(acceptanceEvidence.map(({ evidenceRef }) => evidenceRef))].sort()), effectiveAt, now],
      });
      const updated = await tx.execute({
        sql: `UPDATE experimental_custody_handoff SET status = 'accepted', acceptance_evidence_json = ?,
          decided_at = ?, revision = revision + 1 WHERE workspace_id = ? AND id = ? AND status = 'offered' AND revision = ?`,
        args: [canonicalizeEffectJson(acceptanceEvidence), now, ctx.workspaceId, handoff.id, expectedRevision],
      });
      if (updated.rowsAffected !== 1) throw new Error("custody handoff lost acceptance race");
      await event(tx, { workspaceId: ctx.workspaceId, targetDigest: handoff.targetDigest, actorPrincipalId: ctx.actorPrincipalId,
        eventType: "custody_handoff_accepted", recordType: "custody_state", recordId: stateId,
        payload: { handoffId, predecessorStateId: source.id, custodianPrincipalId: handoff.toPrincipalId,
          conditionDigest, acceptanceEvidence }, now });
      await saveReplay(tx, ctx, "accept", requestDigest, "state", stateId, now);
      return { handoff: (await handoffById(tx, ctx.workspaceId, handoff.id))!, state: (await stateById(tx, ctx.workspaceId, stateId))! };
    });
  }

  async refuse(handoffIdInput: string, input: { expectedRevision: number; reason: string }, contextInput: CustodyMutationContext): Promise<Handoff> {
    const ctx = context(contextInput);
    const handoffId = required(handoffIdInput, "handoffId");
    const expectedRevision = positiveInteger(input.expectedRevision, "expectedRevision");
    const reason = required(input.reason, "reason");
    const requestDigest = custodyDigest("tasq.custody.refuse.v1", { handoffId, expectedRevision, reason });
    return this.write(async (tx, now) => {
      const prior = await replay(tx, ctx, "refuse", requestDigest);
      if (prior) {
        if (prior.resultType !== "handoff") throw new Error("custody replay type mismatch");
        const found = await handoffById(tx, ctx.workspaceId, prior.resultId);
        if (!found) throw new Error("custody replay handoff missing");
        return found;
      }
      const handoff = await handoffById(tx, ctx.workspaceId, handoffId);
      if (!handoff) throw new Error("custody handoff not found");
      if (handoff.status !== "offered" || handoff.revision !== expectedRevision) throw new Error("custody handoff is terminal or stale");
      if (handoff.toPrincipalId !== ctx.actorPrincipalId) throw new Error("only the proposed recipient may refuse custody");
      const updated = await tx.execute({
        sql: `UPDATE experimental_custody_handoff SET status = 'refused', decided_at = ?, refusal_reason = ?,
          revision = revision + 1 WHERE workspace_id = ? AND id = ? AND status = 'offered' AND revision = ?`,
        args: [now, reason, ctx.workspaceId, handoffId, expectedRevision],
      });
      if (updated.rowsAffected !== 1) throw new Error("custody handoff lost refusal race");
      await event(tx, { workspaceId: ctx.workspaceId, targetDigest: handoff.targetDigest, actorPrincipalId: ctx.actorPrincipalId,
        eventType: "custody_handoff_refused", recordType: "custody_handoff", recordId: handoffId,
        payload: { reason }, now });
      await saveReplay(tx, ctx, "refuse", requestDigest, "handoff", handoffId, now);
      return (await handoffById(tx, ctx.workspaceId, handoffId))!;
    });
  }

  async reportIncident(input: {
    targetDigest: string; stateId: string; kindUri: string; summary: string;
    evidenceRefs: string[]; occurredAt: number;
  }, contextInput: CustodyMutationContext): Promise<Incident> {
    const ctx = context(contextInput);
    const targetDigest = digest(input.targetDigest, "targetDigest");
    const stateId = required(input.stateId, "stateId");
    const parsedKindUri = new URL(input.kindUri);
    const kindUri = parsedKindUri.href;
    if (kindUri !== input.kindUri || parsedKindUri.username || parsedKindUri.password) {
      throw new Error("kindUri must be a canonical absolute URI without credentials");
    }
    const summary = input.summary.trim();
    if (!summary || summary.length > 2_000) throw new Error("incident summary must contain 1-2000 characters");
    const evidenceRefs = refs(input.evidenceRefs, "evidenceRefs");
    const occurredAt = unixMs(input.occurredAt, "occurredAt");
    const requestDigest = custodyDigest("tasq.custody.incident.v1", { targetDigest, stateId, kindUri, summary, evidenceRefs, occurredAt });
    return this.write(async (tx, now) => {
      const prior = await replay(tx, ctx, "incident", requestDigest);
      if (prior) {
        if (prior.resultType !== "incident") throw new Error("custody replay type mismatch");
        const found = await tx.execute({ sql: "SELECT * FROM experimental_custody_incident WHERE workspace_id = ? AND id = ?", args: [ctx.workspaceId, prior.resultId] });
        if (!found.rows[0]) throw new Error("custody replay incident missing");
        return parseIncident(found.rows[0] as Record<string, unknown>);
      }
      if (occurredAt > now) throw new Error("incident occurredAt cannot be in the future");
      const state = await stateById(tx, ctx.workspaceId, stateId);
      if (!state || state.targetDigest !== targetDigest) throw new Error("incident state not found for target");
      const id = uuidv7(now);
      await tx.execute({
        sql: `INSERT INTO experimental_custody_incident(
          id, workspace_id, target_digest, state_id, reporter_principal_id, kind_uri, summary,
          evidence_refs_json, occurred_at, recorded_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [id, ctx.workspaceId, targetDigest, stateId, ctx.actorPrincipalId, kindUri, summary,
          canonicalizeEffectJson(evidenceRefs), occurredAt, now],
      });
      await event(tx, { workspaceId: ctx.workspaceId, targetDigest, actorPrincipalId: ctx.actorPrincipalId,
        eventType: "custody_incident_reported", recordType: "custody_incident", recordId: id,
        payload: { stateId, kindUri, evidenceRefs }, now });
      await saveReplay(tx, ctx, "incident", requestDigest, "incident", id, now);
      const found = await tx.execute({ sql: "SELECT * FROM experimental_custody_incident WHERE id = ?", args: [id] });
      return parseIncident(found.rows[0] as Record<string, unknown>);
    });
  }

  async current(workspaceIdInput: string, targetDigestInput: string, inspectedAt = this.now()): Promise<CustodyCurrentViewV1 | null> {
    const workspaceId = required(workspaceIdInput, "workspaceId");
    const targetDigest = digest(targetDigestInput, "targetDigest");
    unixMs(inspectedAt, "inspectedAt");
    const [targetResult, statesResult, handoffsResult, incidentsResult] = await Promise.all([
      this.client.execute({ sql: "SELECT * FROM experimental_custody_target WHERE workspace_id = ? AND target_digest = ?", args: [workspaceId, targetDigest] }),
      this.client.execute({ sql: "SELECT * FROM experimental_custody_state WHERE workspace_id = ? AND target_digest = ? ORDER BY recorded_at, id", args: [workspaceId, targetDigest] }),
      this.client.execute({ sql: "SELECT * FROM experimental_custody_handoff WHERE workspace_id = ? AND target_digest = ? ORDER BY offered_at, id", args: [workspaceId, targetDigest] }),
      this.client.execute({ sql: "SELECT * FROM experimental_custody_incident WHERE workspace_id = ? AND target_digest = ? ORDER BY recorded_at, id", args: [workspaceId, targetDigest] }),
    ]);
    if (!targetResult.rows[0]) return null;
    const states = statesResult.rows.map((row) => parseState(row as Record<string, unknown>));
    const predecessorIds = new Set(states.flatMap(({ predecessorStateId }) => predecessorStateId ? [predecessorStateId] : []));
    const currentStates = states.filter(({ id }) => !predecessorIds.has(id));
    if (currentStates.length !== 1) throw new Error("custody lineage has no unique current state");
    return {
      contractVersion: CUSTODY_MODULE_VERSION,
      assurance: { recordedLineageIsPhysicalTruth: false, grantsOwnershipOrEffectAuthority: false },
      target: parseTarget(targetResult.rows[0] as Record<string, unknown>),
      currentState: currentStates[0]!, states,
      handoffs: handoffsResult.rows.map((row) => parseHandoff(row as Record<string, unknown>)),
      incidents: incidentsResult.rows.map((row) => parseIncident(row as Record<string, unknown>)),
      inspectedAt,
    };
  }

  async exportPortable(workspaceIdInput: string, exportedAt = this.now()): Promise<CustodyPortableV1> {
    const workspaceId = required(workspaceIdInput, "workspaceId");
    unixMs(exportedAt, "exportedAt");
    const [targets, states, handoffs, incidents] = await Promise.all([
      this.client.execute({ sql: "SELECT * FROM experimental_custody_target WHERE workspace_id = ? ORDER BY target_digest", args: [workspaceId] }),
      this.client.execute({ sql: "SELECT * FROM experimental_custody_state WHERE workspace_id = ? ORDER BY recorded_at, id", args: [workspaceId] }),
      this.client.execute({ sql: "SELECT * FROM experimental_custody_handoff WHERE workspace_id = ? ORDER BY offered_at, id", args: [workspaceId] }),
      this.client.execute({ sql: "SELECT * FROM experimental_custody_incident WHERE workspace_id = ? ORDER BY recorded_at, id", args: [workspaceId] }),
    ]);
    const withoutDigest = {
      contractVersion: CUSTODY_PORTABLE_VERSION,
      workspaceId,
      exportedAt,
      targets: targets.rows.map((row) => parseTarget(row as Record<string, unknown>)),
      states: states.rows.map((row) => parseState(row as Record<string, unknown>)),
      handoffs: handoffs.rows.map((row) => parseHandoff(row as Record<string, unknown>)),
      incidents: incidents.rows.map((row) => parseIncident(row as Record<string, unknown>)),
      omissions: ["idempotency", "operational_events"] as ["idempotency", "operational_events"],
    };
    return { ...withoutDigest, exportDigest: custodyDigest("tasq.custody-portable.v1", withoutDigest) };
  }

  /** Create-only import: validates the complete packet and inserts no operational retry/event state. */
  async importPortable(packet: CustodyPortableV1): Promise<void> {
    const { exportDigest, ...withoutDigest } = packet;
    if (custodyDigest("tasq.custody-portable.v1", withoutDigest) !== exportDigest) throw new Error("custody portable digest mismatch");
    if (packet.contractVersion !== CUSTODY_PORTABLE_VERSION || canonicalizeEffectJson(packet.omissions) !== '["idempotency","operational_events"]') {
      throw new Error("unsupported custody portable contract");
    }
    const targets = packet.targets.map((value) => CustodyTargetV1.parse(value));
    const states = packet.states.map((value) => CustodyStateV1.parse(value));
    const handoffs = packet.handoffs.map((value) => CustodyHandoffV1.parse(value));
    const incidents = packet.incidents.map((value) => CustodyIncidentV1.parse(value));
    if ([...targets, ...states, ...handoffs, ...incidents].some(({ workspaceId }) => workspaceId !== packet.workspaceId)) {
      throw new Error("custody portable workspace mismatch");
    }
    const targetByDigest = new Map(targets.map((target) => [target.targetDigest, target]));
    const stateByIdentity = new Map(states.map((state) => [state.id, state]));
    const handoffByIdentity = new Map(handoffs.map((handoff) => [handoff.id, handoff]));
    if (targetByDigest.size !== targets.length || stateByIdentity.size !== states.length || handoffByIdentity.size !== handoffs.length) {
      throw new Error("custody portable identities must be unique");
    }
    for (const target of targets) {
      if (prepareTargetRefV1(target.target).targetDigest !== target.targetDigest) {
        throw new Error("custody portable target digest mismatch");
      }
    }
    const statesPerAcceptedHandoff = new Map<string, number>();
    const rootsPerTarget = new Map<string, number>();
    const successorsPerState = new Map<string, number>();
    for (const state of states) {
      if (!targetByDigest.has(state.targetDigest)) throw new Error("custody portable state target missing");
      if (custodyDigest("tasq.custody-condition.v1", state.condition) !== state.conditionDigest) {
        throw new Error("custody portable state condition digest mismatch");
      }
      if (state.predecessorStateId === null) {
        if (state.acceptedHandoffId !== null) throw new Error("custody portable root cannot cite a handoff");
        rootsPerTarget.set(state.targetDigest, (rootsPerTarget.get(state.targetDigest) ?? 0) + 1);
      } else {
        const predecessor = stateByIdentity.get(state.predecessorStateId);
        const accepted = state.acceptedHandoffId ? handoffByIdentity.get(state.acceptedHandoffId) : undefined;
        if (!predecessor || !accepted || accepted.status !== "accepted") {
          throw new Error("custody portable successor requires an accepted handoff and predecessor");
        }
        if (predecessor.targetDigest !== state.targetDigest || accepted.targetDigest !== state.targetDigest ||
          accepted.sourceStateId !== predecessor.id || accepted.toPrincipalId !== state.custodianPrincipalId ||
          accepted.conditionDigest !== state.conditionDigest) {
          throw new Error("custody portable accepted handoff does not bind the successor exactly");
        }
        successorsPerState.set(predecessor.id, (successorsPerState.get(predecessor.id) ?? 0) + 1);
        statesPerAcceptedHandoff.set(accepted.id, (statesPerAcceptedHandoff.get(accepted.id) ?? 0) + 1);
      }
    }
    if ([...targetByDigest.keys()].some((targetDigest) => rootsPerTarget.get(targetDigest) !== 1) ||
      [...successorsPerState.values()].some((count) => count !== 1)) {
      throw new Error("custody portable lineage must have one root and at most one successor");
    }
    for (const handoff of handoffs) {
      const source = stateByIdentity.get(handoff.sourceStateId);
      if (!source || source.targetDigest !== handoff.targetDigest || source.custodianPrincipalId !== handoff.fromPrincipalId) {
        throw new Error("custody portable handoff source mismatch");
      }
      if (custodyDigest("tasq.custody-condition.v1", handoff.condition) !== handoff.conditionDigest) {
        throw new Error("custody portable handoff condition digest mismatch");
      }
      const successorCount = statesPerAcceptedHandoff.get(handoff.id) ?? 0;
      const requirements = new Set(handoff.evidenceRequirements);
      const suppliedRequirements = new Set(handoff.acceptanceEvidence.map(({ requirement }) => requirement));
      if (handoff.evidenceRequirements.length === 0 || requirements.size !== handoff.evidenceRequirements.length ||
        handoff.acceptanceEvidence.length !== suppliedRequirements.size ||
        (handoff.status === "accepted" && (requirements.size !== suppliedRequirements.size ||
          [...requirements].some((requirement) => !suppliedRequirements.has(requirement))))) {
        throw new Error("custody portable handoff evidence requirements are inconsistent");
      }
      if ((handoff.status === "accepted" && successorCount !== 1) ||
        (handoff.status !== "accepted" && successorCount !== 0)) {
        throw new Error("custody portable handoff status disagrees with successor lineage");
      }
      if ((handoff.status === "offered" && (handoff.revision !== 1 || handoff.decidedAt !== null || handoff.refusalReason !== null || handoff.acceptanceEvidence.length !== 0)) ||
        (handoff.status === "accepted" && (handoff.revision !== 2 || handoff.decidedAt === null || handoff.refusalReason !== null || handoff.acceptanceEvidence.length === 0)) ||
        (handoff.status === "refused" && (handoff.revision !== 2 || handoff.decidedAt === null || handoff.refusalReason === null || handoff.acceptanceEvidence.length !== 0))) {
        throw new Error("custody portable handoff lifecycle is inconsistent");
      }
    }
    for (const incident of incidents) {
      const state = stateByIdentity.get(incident.stateId);
      if (!state || state.targetDigest !== incident.targetDigest) throw new Error("custody portable incident state mismatch");
    }
    await this.write(async (tx) => {
      const existing = await tx.execute("SELECT 1 AS present FROM experimental_custody_target LIMIT 1");
      if (existing.rows[0]) throw new Error("custody portable import requires an empty store");
      for (const target of targets) await tx.execute({
        sql: "INSERT INTO experimental_custody_target(workspace_id,target_digest,target_json,created_at) VALUES (?,?,?,?)",
        args: [target.workspaceId, target.targetDigest, canonicalizeEffectJson(target.target), target.createdAt],
      });
      const remaining = new Map(states.map((state) => [state.id, state]));
      while (remaining.size) {
        let progressed = false;
        for (const state of [...remaining.values()]) {
          if (state.predecessorStateId && remaining.has(state.predecessorStateId)) continue;
          await tx.execute({
            sql: `INSERT INTO experimental_custody_state(id,workspace_id,target_digest,custodian_principal_id,
              predecessor_state_id,accepted_handoff_id,condition_json,condition_digest,evidence_refs_json,effective_at,recorded_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
            args: [state.id, state.workspaceId, state.targetDigest, state.custodianPrincipalId, state.predecessorStateId,
              state.acceptedHandoffId, canonicalizeEffectJson(state.condition), state.conditionDigest,
              canonicalizeEffectJson(state.evidenceRefs), state.effectiveAt, state.recordedAt],
          });
          remaining.delete(state.id); progressed = true;
        }
        if (!progressed) throw new Error("custody portable state lineage has a cycle or missing predecessor");
      }
      for (const handoff of handoffs) await tx.execute({
        sql: `INSERT INTO experimental_custody_handoff(id,workspace_id,target_digest,source_state_id,from_principal_id,
          to_principal_id,status,condition_json,condition_digest,evidence_requirements_json,acceptance_evidence_json,
          offered_at,expires_at,decided_at,refusal_reason,revision) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        args: [handoff.id, handoff.workspaceId, handoff.targetDigest, handoff.sourceStateId, handoff.fromPrincipalId,
          handoff.toPrincipalId, handoff.status, canonicalizeEffectJson(handoff.condition), handoff.conditionDigest,
          canonicalizeEffectJson(handoff.evidenceRequirements), canonicalizeEffectJson(handoff.acceptanceEvidence),
          handoff.offeredAt, handoff.expiresAt, handoff.decidedAt, handoff.refusalReason, handoff.revision],
      });
      for (const incident of incidents) await tx.execute({
        sql: `INSERT INTO experimental_custody_incident(id,workspace_id,target_digest,state_id,reporter_principal_id,
          kind_uri,summary,evidence_refs_json,occurred_at,recorded_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        args: [incident.id, incident.workspaceId, incident.targetDigest, incident.stateId, incident.reporterPrincipalId,
          incident.kindUri, incident.summary, canonicalizeEffectJson(incident.evidenceRefs), incident.occurredAt, incident.recordedAt],
      });
    });
  }
}
