import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import {
  effect as effectTable,
  effectApproval as approvalTable,
  effectReceipt as receiptTable,
} from "@tasq/schema";
import {
  createHmacEffectPermitAuthenticator,
  enforceEffectDispatch,
  type EffectConnectorPolicy,
  type EffectReceiptVerifier,
} from "@tasq/extension-sdk";
import {
  acquireTaskClaim,
  authorizeEffect,
  beginEffectExecution,
  cancelEffect,
  createCommitment,
  createPrincipal,
  getEffectiveEffectApproval,
  getEffect,
  getEffectReceipt,
  getCommitment,
  inspectCommitment,
  listEffectApprovals,
  listEffectReceipts,
  listEffects,
  listEvents,
  listTaskEvidence,
  openDb,
  proposeEffect,
  recordEffectReceipt,
  recordEffectApproval,
  runKernelMigrations,
  startTaskAttempt,
} from "../src/kernel.js";
import { assertDatabaseInvariantRejected } from "./support/database-invariant.js";
import { diagnoseStore, installExtension } from "../src/index.js";

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

const EFFECT_TYPE_URI = "https://acme.example/effects/money-transfer";
const permitAuthenticator = createHmacEffectPermitAuthenticator("service-test-key", "p".repeat(32));
const EFFECT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  properties: {
    amountMinor: { type: "integer" },
    currency: { type: "string" },
    recipientRef: { type: "string" },
  },
  required: ["amountMinor", "currency", "recipientRef"],
};

async function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "tasq-effects-"));
  tmpDirs.push(dir);
  const handle = await openDb({ url: `file:${join(dir, "db.sqlite")}`, wal: false });
  await runKernelMigrations(handle.client, { now: 10_000 });
  await installExtension(handle.db, {
    extensionUri: "https://acme.example/extensions/payments",
    version: "1.0.0",
    types: [{ recordKind: "effect", typeUri: EFFECT_TYPE_URI, schemaVersion: 1, schema: EFFECT_SCHEMA }],
    evaluators: [],
  }, { actor: "admin", now: 10_100 });
  return handle;
}

function exactRequest(amountMinor = 5_800, workspaceId = "gwendall") {
  return {
    protocol: "tasq.effect-request.v1" as const,
    canonicalization: "tasq.jcs-safe-integer.v1" as const,
    digestAlgorithm: "sha-256" as const,
    workspaceId,
    effectTypeUri: EFFECT_TYPE_URI,
    effectSchemaVersion: 1,
    connector: {
      operationUri: "https://acme.example/connectors/payments/transfer",
      operationVersion: 1,
      contractDigest: `sha256:${"a".repeat(64)}`,
      instanceRef: "connector:payments:primary",
      bindingDigest: `sha256:${"b".repeat(64)}`,
    },
    parameters: { amountMinor, currency: "EUR", recipientRef: "recipient:alice" },
    secretBindings: [],
  };
}

function transferPolicy(maxAmountMinor = 5_800): EffectConnectorPolicy {
  return {
    effectTypeUri: EFFECT_TYPE_URI,
    effectSchemaVersion: 1,
    operationUri: "https://acme.example/connectors/payments/transfer",
    operationVersion: 1,
    contractDigest: `sha256:${"a".repeat(64)}`,
    instanceRef: "connector:payments:primary",
    bindingDigest: `sha256:${"b".repeat(64)}`,
    parseParameters(input) {
      const value = input as Record<string, unknown>;
      if (!Number.isSafeInteger(value.amountMinor) || typeof value.currency !== "string" ||
        typeof value.recipientRef !== "string" || Object.keys(value).length !== 3) {
        throw new Error("invalid transfer parameters");
      }
      return value as { amountMinor: number; currency: string; recipientRef: string };
    },
    evaluateAuthority(input) {
      const allowed = input.verificationLevel !== "self_asserted" &&
        input.scope.connectorInstanceRef === "connector:payments:primary" &&
        Number(input.parameters.amountMinor) <= Number(input.limits.maxAmountMinor ?? 0) &&
        Number(input.parameters.amountMinor) <= maxAmountMinor;
      return {
        allowed,
        reasonCode: allowed ? "within_transfer_authority" : "outside_transfer_authority",
        explanation: allowed ? "Exact transfer is authorized." : "Transfer exceeds or mismatches authority.",
      };
    },
  };
}

async function fixture() {
  const handle = await freshDb();
  const proposer = await createPrincipal(handle.db, {
    displayName: "Proposer",
    kind: "agent",
    localAlias: "proposer",
  }, { now: 10_200 });
  const approver = await createPrincipal(handle.db, {
    displayName: "Approver",
    kind: "human",
    localAlias: "approver",
  }, { now: 10_300 });
  const commitment = await createCommitment(handle.db, {
    title: "Pay exact invoice",
    successCriteria: "Provider receipt is verified",
  }, { workspaceId: "gwendall", actor: "proposer", now: 10_400 });
  return { ...handle, proposer, approver, commitment };
}

const strongReceiptVerifier: EffectReceiptVerifier = {
  verify: ({ report, now }) => ({
    level: "cryptographic",
    method: "test-provider-signature-v1",
    coverage: ["provider_account", "provider_operation", "request_identity", "outcome"],
    details: { keyRef: "provider-key:1", verifiedAt: now, rawDigest: report.rawDigest },
  }),
};

const uncertaintyVerifier: EffectReceiptVerifier = {
  verify: ({ now }) => ({
    level: "self_asserted",
    method: "connector-transport-observation",
    coverage: [],
    details: { observedAt: now },
  }),
};

function receiptReport(
  begun: Awaited<ReturnType<typeof beginEffectExecution>>,
  overrides: Record<string, unknown> = {},
) {
  const payload = begun.permit.payload;
  return {
    protocol: "tasq.effect-receipt.v1" as const,
    workspaceId: payload.workspaceId,
    effectId: payload.effectId,
    requestDigest: payload.requestDigest,
    dispatchIdempotencyKey: payload.dispatchIdempotencyKey,
    approvalId: payload.approval.id,
    claimId: payload.claim.id,
    fence: payload.claim.fence,
    connectorInstanceRef: payload.request.connector.instanceRef,
    connectorBindingDigest: payload.request.connector.bindingDigest,
    externalReceiptId: `receipt:${payload.effectId}`,
    providerOperationId: `provider-op:${payload.effectId}`,
    outcome: "committed" as const,
    occurredAt: payload.issuedAt + 10,
    rawRef: `urn:provider-receipt:${payload.effectId}`,
    rawDigest: `sha256:${"d".repeat(64)}`,
    payload: { providerStatus: "accepted" },
    resolvesReceiptId: null,
    ...overrides,
  };
}

async function executingFixture() {
  const base = await fixture();
  const claim = await acquireTaskClaim(base.db, base.commitment.id, {
    principalId: base.proposer.id, actor: "proposer", leaseMs: 20_000, now: 11_000,
  });
  const attempt = await startTaskAttempt(base.db, base.commitment.id, {
    principalId: base.proposer.id, actor: "proposer", claimId: claim.id,
    runtime: "connector-test", occurredAt: 11_100,
  });
  const proposed = await proposeEffect(base.db, {
    taskId: base.commitment.id, attemptId: attempt.id, request: exactRequest(),
  }, { principalId: base.proposer.id, now: 11_200 });
  const approval = await recordEffectApproval(base.db, {
    effectId: proposed.id,
    decision: "approved",
    scope: { connectorInstanceRef: "connector:payments:primary" },
    limits: { maxAmountMinor: 5_800 },
    expiresAt: 25_000,
  }, {
    principalId: base.approver.id,
    now: 11_300,
    authorityVerification: {
      level: "authenticated_context", method: "test-session", details: { sessionRef: "session:receipt" },
    },
  });
  const authorized = await authorizeEffect(base.db, proposed.id, approval.id, {
    principalId: base.proposer.id, expectedRevision: proposed.revision, now: 11_400,
  });
  const begun = await beginEffectExecution(base.db, proposed.id, {
    principalId: base.proposer.id,
    expectedRevision: authorized.revision,
    claimId: claim.id,
    fence: claim.fence,
    policy: transferPolicy(),
    permitIssuer: permitAuthenticator,
    idempotencyKey: "fixture-effect-begin",
    now: 11_500,
  });
  return { ...base, claim, attempt, proposed, approval, authorized, begun };
}

describe("K2 effect and approval ledger", () => {
  test("proposes one immutable exact effect and deduplicates only exact retries", async () => {
    const { db, client, close, proposer, commitment } = await fixture();
    try {
      const input = { taskId: commitment.id, request: exactRequest() };
      const first = await proposeEffect(db, input, {
        principalId: proposer.id,
        now: 11_000,
        idempotencyKey: "effect-proposal-1",
      });
      expect(first).toMatchObject({
        taskId: commitment.id,
        status: "proposed",
        revision: 1,
        createdAt: 11_000,
        createdByPrincipalId: proposer.id,
      });
      expect(first.requestDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(first.dispatchIdempotencyKey).toMatch(/^tqfx1_[A-Za-z0-9_-]{43}$/);
      expect(first.canonicalRequest).toBe(JSON.stringify(JSON.parse(first.canonicalRequest)));

      const retry = await proposeEffect(db, input, {
        principalId: proposer.id,
        now: 12_000,
        idempotencyKey: "effect-proposal-1",
      });
      expect(retry).toEqual(first);
      await expect(proposeEffect(db, {
        taskId: commitment.id,
        request: exactRequest(580_000),
      }, {
        principalId: proposer.id,
        now: 12_100,
        idempotencyKey: "effect-proposal-1",
      })).rejects.toThrow(/different request/);

      expect(await listEffects(db, { taskId: commitment.id })).toHaveLength(1);
      expect((await listEvents(db, { entityId: commitment.id })).map((event) => event.eventType))
        .toContain("effect_proposed");

      await assertDatabaseInvariantRejected(
        Promise.resolve(db.update(effectTable)
          .set({ requestDigest: `sha256:${"f".repeat(64)}`, revision: 2 })
          .where(eq(effectTable.id, first.id))),
        /immutable/,
      );
      expect(await diagnoseStore(db, client)).toMatchObject({ ok: true, issues: [] });
    } finally {
      await close();
    }
  });

  test("binds an immutable approval to the exact digest and withdraws stale authority", async () => {
    const { db, close, proposer, approver, commitment } = await fixture();
    try {
      const proposed = await proposeEffect(db, { taskId: commitment.id, request: exactRequest() }, {
        principalId: proposer.id,
        now: 11_000,
      });
      const approved = await recordEffectApproval(db, {
        effectId: proposed.id,
        decision: "approved",
        scope: { connectorInstanceRef: "connector:payments:primary" },
        limits: { maxAmountMinor: 5_800 },
        expiresAt: 20_000,
      }, {
        principalId: approver.id,
        now: 12_000,
        idempotencyKey: "approve-1",
        authorityVerification: {
          level: "authenticated_context",
          method: "local-test-session",
          details: { sessionRef: "session:1" },
        },
      });
      expect(approved).toMatchObject({
        effectId: proposed.id,
        requestDigest: proposed.requestDigest,
        approverPrincipalId: approver.id,
        decision: "approved",
        verificationLevel: "authenticated_context",
      });
      expect(await recordEffectApproval(db, {
        effectId: proposed.id,
        decision: "approved",
        scope: { connectorInstanceRef: "connector:payments:primary" },
        limits: { maxAmountMinor: 5_800 },
        expiresAt: 20_000,
      }, {
        principalId: approver.id,
        now: 12_500,
        idempotencyKey: "approve-1",
        authorityVerification: {
          level: "authenticated_context",
          method: "local-test-session",
          details: { sessionRef: "session:1" },
        },
      })).toEqual(approved);

      const authorized = await authorizeEffect(db, proposed.id, approved.id, {
        principalId: proposer.id,
        expectedRevision: 1,
        now: 13_000,
      });
      expect(authorized).toMatchObject({
        status: "authorized",
        authorizedByApprovalId: approved.id,
        authorizedAt: 13_000,
        revision: 2,
      });

      const revoked = await recordEffectApproval(db, {
        effectId: proposed.id,
        decision: "revoked",
        supersedesApprovalId: approved.id,
      }, { principalId: approver.id, now: 14_000 });
      expect(revoked).toMatchObject({ decision: "revoked", supersedesApprovalId: approved.id });
      expect(await getEffectiveEffectApproval(db, proposed.id)).toEqual(revoked);
      expect(await getEffect(db, proposed.id)).toMatchObject({ status: "proposed", revision: 3 });
      await expect(authorizeEffect(db, proposed.id, approved.id, {
        principalId: proposer.id,
        expectedRevision: 3,
        now: 14_100,
      })).rejects.toThrow(/current approved/);

      const replacement = await recordEffectApproval(db, {
        effectId: proposed.id,
        decision: "approved",
        supersedesApprovalId: revoked.id,
        expiresAt: 16_000,
      }, { principalId: approver.id, now: 15_000 });
      expect(await authorizeEffect(db, proposed.id, replacement.id, {
        principalId: proposer.id,
        expectedRevision: 3,
        now: 15_999,
      })).toMatchObject({ status: "authorized", revision: 4 });

      await assertDatabaseInvariantRejected(
        Promise.resolve(db.update(approvalTable).set({ decision: "denied" })
          .where(eq(approvalTable.id, replacement.id))),
        /immutable/,
      );
      expect(await listEffectApprovals(db, { effectId: proposed.id })).toHaveLength(3);
    } finally {
      await close();
    }
  });

  test("uses exclusive injected expiry boundaries and never authorizes an expired decision", async () => {
    const { db, close, proposer, approver, commitment } = await fixture();
    try {
      const proposed = await proposeEffect(db, { taskId: commitment.id, request: exactRequest() }, {
        principalId: proposer.id,
        now: 11_000,
      });
      const approval = await recordEffectApproval(db, {
        effectId: proposed.id,
        decision: "approved",
        validFrom: 12_000,
        expiresAt: 13_000,
      }, { principalId: approver.id, now: 11_500 });
      await expect(authorizeEffect(db, proposed.id, approval.id, {
        principalId: proposer.id,
        expectedRevision: 1,
        now: 11_999,
      })).rejects.toThrow(/not valid yet/);
      await expect(authorizeEffect(db, proposed.id, approval.id, {
        principalId: proposer.id,
        expectedRevision: 1,
        now: 13_000,
      })).rejects.toThrow(/expired/);
      expect(await authorizeEffect(db, proposed.id, approval.id, {
        principalId: proposer.id,
        expectedRevision: 1,
        now: 12_000,
      })).toMatchObject({ authorizedAt: 12_000 });
    } finally {
      await close();
    }
  });

  test("cancels only before dispatch and represents a correction as a new occurrence", async () => {
    const { db, close, proposer, commitment } = await fixture();
    try {
      const original = await proposeEffect(db, { taskId: commitment.id, request: exactRequest() }, {
        principalId: proposer.id,
        now: 11_000,
      });
      const cancelled = await cancelEffect(db, original.id, "Recipient changed", {
        principalId: proposer.id,
        expectedRevision: 1,
        idempotencyKey: "cancel-original-effect",
        now: 12_000,
      });
      expect(cancelled).toMatchObject({
        status: "cancelled",
        revision: 2,
        cancelledAt: 12_000,
        cancelReason: "Recipient changed",
      });
      expect(await cancelEffect(db, original.id, "Recipient changed", {
        principalId: proposer.id,
        expectedRevision: 1,
        idempotencyKey: "cancel-original-effect",
        now: 50_000,
      })).toEqual(cancelled);
      const correction = await proposeEffect(db, {
        taskId: commitment.id,
        request: exactRequest(5_900),
        supersedesEffectId: original.id,
      }, { principalId: proposer.id, now: 13_000 });
      expect(correction).toMatchObject({ status: "proposed", supersedesEffectId: original.id });
      expect(correction.id).not.toBe(original.id);
      expect(correction.requestDigest).not.toBe(original.requestDigest);
      expect(correction.dispatchIdempotencyKey).not.toBe(original.dispatchIdempotencyKey);
      await expect(proposeEffect(db, {
        taskId: commitment.id,
        request: exactRequest(6_000),
        supersedesEffectId: original.id,
      }, { principalId: proposer.id, now: 14_000 })).rejects.toThrow();
    } finally {
      await close();
    }
  });

  test("atomically enters executing only with exact policy, active attempt and live fence", async () => {
    const { db, close, proposer, approver, commitment } = await fixture();
    try {
      const claim = await acquireTaskClaim(db, commitment.id, {
        principalId: proposer.id,
        actor: "proposer",
        leaseMs: 10_000,
        now: 11_000,
      });
      const attempt = await startTaskAttempt(db, commitment.id, {
        principalId: proposer.id,
        actor: "proposer",
        claimId: claim.id,
        runtime: "connector-test",
        occurredAt: 11_100,
      });
      const proposed = await proposeEffect(db, {
        taskId: commitment.id,
        attemptId: attempt.id,
        request: exactRequest(),
      }, { principalId: proposer.id, now: 11_200 });
      const approval = await recordEffectApproval(db, {
        effectId: proposed.id,
        decision: "approved",
        scope: { connectorInstanceRef: "connector:payments:primary" },
        limits: { maxAmountMinor: 5_800 },
        expiresAt: 20_000,
      }, {
        principalId: approver.id,
        now: 11_300,
        authorityVerification: {
          level: "authenticated_context",
          method: "test-session",
          details: { sessionRef: "session:dispatch" },
        },
      });
      const authorized = await authorizeEffect(db, proposed.id, approval.id, {
        principalId: proposer.id,
        expectedRevision: proposed.revision,
        idempotencyKey: "authorize-dispatch-effect",
        now: 11_400,
      });
      expect(await authorizeEffect(db, proposed.id, approval.id, {
        principalId: proposer.id,
        expectedRevision: proposed.revision,
        idempotencyKey: "authorize-dispatch-effect",
        now: 11_450,
      })).toEqual(authorized);

      await assertDatabaseInvariantRejected(
        Promise.resolve(db.update(effectTable).set({
          status: "executing",
          claimId: claim.id,
          fence: claim.fence + 1,
          executionStartedAt: 11_450,
          updatedAt: 11_450,
          revision: authorized.revision + 1,
        }).where(eq(effectTable.id, proposed.id))),
        /live claim fence|running attempt/,
      );

      await expect(beginEffectExecution(db, proposed.id, {
        principalId: proposer.id,
        expectedRevision: authorized.revision,
        claimId: claim.id,
        fence: claim.fence + 1,
        policy: transferPolicy(),
        permitIssuer: permitAuthenticator,
        now: 11_500,
      })).rejects.toThrow(/live claim fence/);
      await expect(beginEffectExecution(db, proposed.id, {
        principalId: proposer.id,
        expectedRevision: authorized.revision,
        claimId: claim.id,
        fence: claim.fence,
        policy: transferPolicy(5_799),
        permitIssuer: permitAuthenticator,
        now: 11_500,
      })).rejects.toThrow(/outside_transfer_authority/);
      expect((await getEffect(db, proposed.id))?.status).toBe("authorized");

      const begun = await beginEffectExecution(db, proposed.id, {
        principalId: proposer.id,
        expectedRevision: authorized.revision,
        claimId: claim.id,
        fence: claim.fence,
        policy: transferPolicy(),
        permitIssuer: permitAuthenticator,
        idempotencyKey: "begin-dispatch-effect",
        now: 11_500,
      });
      expect(begun.effect).toMatchObject({
        status: "executing",
        attemptId: attempt.id,
        claimId: claim.id,
        fence: claim.fence,
        executionStartedAt: 11_500,
      });
      expect(begun.permit.payload).toMatchObject({
        contractVersion: "tasq.effect-dispatch-permit.v1",
        effectId: proposed.id,
        effectRevision: begun.effect.revision,
        approval: { id: approval.id },
        claim: { id: claim.id, fence: claim.fence, principalId: proposer.id },
      });
      expect(enforceEffectDispatch(begun.permit, transferPolicy(), {
        now: 11_501,
        verifier: permitAuthenticator,
      }).parameters)
        .toEqual(exactRequest().parameters);
      const replayed = await beginEffectExecution(db, proposed.id, {
        principalId: proposer.id,
        expectedRevision: authorized.revision,
        claimId: claim.id,
        fence: claim.fence,
        policy: transferPolicy(),
        permitIssuer: permitAuthenticator,
        idempotencyKey: "begin-dispatch-effect",
        now: 19_000,
      });
      expect(replayed).toEqual(begun);
      expect((await listEvents(db, { entityId: commitment.id })).map((event) => event.eventType))
        .toContain("effect_execution_started");
      await expect(cancelEffect(db, proposed.id, "too late", {
        principalId: proposer.id,
        expectedRevision: begun.effect.revision,
        now: 11_600,
      })).rejects.toThrow(/after dispatch/);
    } finally {
      await close();
    }
  });

  test("records one strongly verified terminal receipt and linked evidence without completing", async () => {
    const { db, client, close, proposer, commitment, claim, authorized, begun } = await executingFixture();
    try {
      const report = receiptReport(begun);
      await expect(recordEffectReceipt(db, { report }, {
        principalId: proposer.id,
        expectedRevision: begun.effect.revision,
        verifier: uncertaintyVerifier,
        now: 11_600,
      })).rejects.toThrow(/strong verification/);
      expect((await getEffect(db, begun.effect.id))?.status).toBe("executing");

      const receipt = await recordEffectReceipt(db, { report }, {
        principalId: proposer.id,
        expectedRevision: begun.effect.revision,
        verifier: strongReceiptVerifier,
        now: 11_600,
      });
      expect(receipt).toMatchObject({
        effectId: begun.effect.id,
        taskId: commitment.id,
        attemptId: begun.effect.attemptId,
        approvalId: begun.permit.payload.approval.id,
        report: { outcome: "committed", providerOperationId: `provider-op:${begun.effect.id}` },
        verificationLevel: "cryptographic",
        recordedAt: 11_600,
      });
      const resolved = await getEffect(db, begun.effect.id);
      expect(resolved).toMatchObject({
        status: "committed",
        outcomeReceiptId: receipt.id,
        resolvedAt: 11_600,
      });
      await expect(beginEffectExecution(db, begun.effect.id, {
        principalId: proposer.id,
        expectedRevision: authorized.revision,
        claimId: claim.id,
        fence: claim.fence,
        policy: transferPolicy(),
        permitIssuer: permitAuthenticator,
        idempotencyKey: "fixture-effect-begin",
        now: 11_700,
      })).rejects.toThrow(/already resolved.*inspect its receipt/);
      expect(await getCommitment(db, commitment.id, "gwendall")).toMatchObject({ status: "open" });
      expect(await listTaskEvidence(db, commitment.id)).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: receipt.evidenceId, kind: "effect_receipt", digest: report.rawDigest }),
      ]));
      expect(await listEffectReceipts(db, { effectId: begun.effect.id })).toHaveLength(1);

      const retry = await recordEffectReceipt(db, { report }, {
        principalId: proposer.id,
        expectedRevision: begun.effect.revision,
        verifier: strongReceiptVerifier,
        now: 12_000,
      });
      expect(retry).toEqual(receipt);
      await expect(recordEffectReceipt(db, {
        report: { ...report, payload: { providerStatus: "changed" } },
      }, {
        principalId: proposer.id,
        expectedRevision: resolved!.revision,
        verifier: strongReceiptVerifier,
        now: 12_000,
      })).rejects.toThrow(/reused with different content/);
      await assertDatabaseInvariantRejected(
        Promise.resolve(db.update(receiptTable).set({ recordedAt: 99_999 })
          .where(eq(receiptTable.id, receipt.id))),
        /immutable/,
      );
      expect(await getEffectReceipt(db, receipt.id)).toEqual(receipt);
      const inspection = await inspectCommitment(db, commitment.id, {
        workspaceId: "gwendall",
        now: 12_100,
      });
      expect(inspection?.effectReceipts[0]).toMatchObject({
        id: receipt.id,
        effectId: begun.effect.id,
        report: { outcome: "committed" },
        coverage: [...strongReceiptVerifier.verify({ report, now: 12_100 }).coverage].sort(),
      });
      expect(await diagnoseStore(db, client)).toMatchObject({ ok: true, issues: [] });
      await client.execute("DROP TRIGGER effect_receipt_no_update");
      await client.execute({
        sql: "UPDATE effect_receipt SET receipt_digest = ? WHERE id = ?",
        args: [`sha256:${"0".repeat(64)}`, receipt.id],
      });
      expect((await diagnoseStore(db, client)).issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "effect_receipt_invalid", entityId: receipt.id }),
      ]));
    } finally {
      await close();
    }
  });

  test("records transport uncertainty and resolves it only through a new provider receipt", async () => {
    const { db, client, close, proposer, commitment, begun } = await executingFixture();
    try {
      const uncertaintyReport = receiptReport(begun, {
        externalReceiptId: `timeout:${begun.effect.id}`,
        providerOperationId: null,
        outcome: "indeterminate",
        payload: { errorClass: "transport_timeout", dispatchAcknowledged: false },
      });
      const uncertain = await recordEffectReceipt(db, { report: uncertaintyReport }, {
        principalId: proposer.id,
        expectedRevision: begun.effect.revision,
        verifier: uncertaintyVerifier,
        now: 11_600,
      });
      const indeterminate = await getEffect(db, begun.effect.id);
      expect(indeterminate).toMatchObject({
        status: "indeterminate",
        outcomeReceiptId: uncertain.id,
        indeterminateAt: 11_600,
        resolvedAt: null,
      });

      await expect(recordEffectReceipt(db, {
        report: receiptReport(begun, {
          externalReceiptId: `second-timeout:${begun.effect.id}`,
          providerOperationId: null,
          outcome: "indeterminate",
          payload: { errorClass: "another_timeout" },
        }),
      }, {
        principalId: proposer.id,
        expectedRevision: indeterminate!.revision,
        verifier: uncertaintyVerifier,
        now: 11_700,
      })).rejects.toThrow(/Only an executing effect/);

      const recoveredReport = receiptReport(begun, {
        externalReceiptId: `lookup:${begun.effect.id}`,
        resolvesReceiptId: uncertain.id,
        payload: { providerStatus: "accepted", lookup: true },
        occurredAt: 11_700,
      });
      const recovered = await recordEffectReceipt(db, { report: recoveredReport }, {
        principalId: proposer.id,
        expectedRevision: indeterminate!.revision,
        verifier: strongReceiptVerifier,
        now: 11_800,
      });
      expect(await getEffect(db, begun.effect.id)).toMatchObject({
        status: "committed",
        outcomeReceiptId: recovered.id,
        indeterminateAt: 11_600,
        resolvedAt: 11_800,
      });
      expect((await listEffectReceipts(db, { effectId: begun.effect.id })).map((item) => item.id))
        .toEqual([uncertain.id, recovered.id]);
      expect(await getCommitment(db, commitment.id, "gwendall")).toMatchObject({ status: "open" });
      expect(await diagnoseStore(db, client)).toMatchObject({ ok: true, issues: [] });
    } finally {
      await close();
    }
  });

  test("models compensation as a separately authorized and receipted effect", async () => {
    const { db, close, proposer, approver, commitment, attempt, claim, begun } = await executingFixture();
    try {
      const originalReceipt = await recordEffectReceipt(db, { report: receiptReport(begun) }, {
        principalId: proposer.id,
        expectedRevision: begun.effect.revision,
        verifier: strongReceiptVerifier,
        now: 11_600,
      });
      const original = await getEffect(db, begun.effect.id);
      const compensation = await proposeEffect(db, {
        taskId: commitment.id,
        attemptId: attempt.id,
        request: exactRequest(),
        compensationOfEffectId: original!.id,
      }, { principalId: proposer.id, now: 11_700 });
      expect(compensation.id).not.toBe(original!.id);
      expect(compensation.dispatchIdempotencyKey).not.toBe(original!.dispatchIdempotencyKey);
      const approval = await recordEffectApproval(db, {
        effectId: compensation.id,
        decision: "approved",
        scope: { connectorInstanceRef: "connector:payments:primary" },
        limits: { maxAmountMinor: 5_800 },
        expiresAt: 25_000,
      }, {
        principalId: approver.id,
        now: 11_800,
        authorityVerification: {
          level: "authenticated_context", method: "test-session", details: { purpose: "compensation" },
        },
      });
      const authorized = await authorizeEffect(db, compensation.id, approval.id, {
        principalId: proposer.id, expectedRevision: compensation.revision, now: 11_900,
      });
      const compensationBegun = await beginEffectExecution(db, compensation.id, {
        principalId: proposer.id,
        expectedRevision: authorized.revision,
        claimId: claim.id,
        fence: claim.fence,
        policy: transferPolicy(),
        permitIssuer: permitAuthenticator,
        now: 12_000,
      });
      const compensationReceipt = await recordEffectReceipt(db, {
        report: receiptReport(compensationBegun, {
          externalReceiptId: `compensation:${compensation.id}`,
          providerOperationId: `provider-compensation:${compensation.id}`,
        }),
      }, {
        principalId: proposer.id,
        expectedRevision: compensationBegun.effect.revision,
        verifier: strongReceiptVerifier,
        now: 12_100,
      });
      expect(await getEffect(db, original!.id)).toMatchObject({
        status: "committed", outcomeReceiptId: originalReceipt.id, compensationOfEffectId: null,
      });
      expect(await getEffect(db, compensation.id)).toMatchObject({
        status: "committed",
        compensationOfEffectId: original!.id,
        outcomeReceiptId: compensationReceipt.id,
      });
    } finally {
      await close();
    }
  });

  test("doctor detects effect identity and authority drift after SQL guards are bypassed", async () => {
    const { db, client, close, proposer, approver, commitment } = await fixture();
    try {
      const proposed = await proposeEffect(db, { taskId: commitment.id, request: exactRequest() }, {
        principalId: proposer.id,
        now: 11_000,
      });
      const approval = await recordEffectApproval(db, {
        effectId: proposed.id,
        decision: "approved",
      }, { principalId: approver.id, now: 12_000 });

      await client.execute("DROP TRIGGER effect_revision_and_identity_guard");
      await client.execute("DROP TRIGGER effect_approval_no_update");
      await client.execute({
        sql: "UPDATE effect SET dispatch_idempotency_key = ? WHERE id = ?",
        args: [`tqfx1_${"A".repeat(43)}`, proposed.id],
      });
      await client.execute({
        sql: "UPDATE effect_approval SET scope = ? WHERE id = ?",
        args: ['{"z":1,"a":2}', approval.id],
      });

      const report = await diagnoseStore(db, client);
      expect(report.ok).toBe(false);
      expect(report.issues.map((item) => item.code)).toContain("effect_request_identity_drift");
      expect(report.issues.map((item) => item.code)).toContain("effect_approval_invalid");
    } finally {
      await close();
    }
  });

  test("fails closed on unknown types, workspace mismatch and approval branching", async () => {
    const { db, close, proposer, approver, commitment } = await fixture();
    try {
      await expect(proposeEffect(db, {
        taskId: commitment.id,
        request: { ...exactRequest(), effectTypeUri: "https://unknown.example/effect" },
      }, { principalId: proposer.id, now: 11_000 })).rejects.toThrow(/Unsupported effect type/);
      await expect(proposeEffect(db, {
        taskId: commitment.id,
        request: exactRequest(5_800, "other"),
      }, { principalId: proposer.id, now: 11_000 })).rejects.toThrow(/workspaceId/);

      const proposed = await proposeEffect(db, { taskId: commitment.id, request: exactRequest() }, {
        principalId: proposer.id,
        now: 11_100,
      });
      const root = await recordEffectApproval(db, {
        effectId: proposed.id,
        decision: "denied",
      }, { principalId: approver.id, now: 11_200 });
      await expect(recordEffectApproval(db, {
        effectId: proposed.id,
        decision: "approved",
      }, { principalId: approver.id, now: 11_300 })).rejects.toThrow(/must supersede/);
      const leaf = await recordEffectApproval(db, {
        effectId: proposed.id,
        decision: "approved",
        supersedesApprovalId: root.id,
      }, { principalId: approver.id, now: 11_400 });
      await expect(recordEffectApproval(db, {
        effectId: proposed.id,
        decision: "approved",
        supersedesApprovalId: root.id,
      }, { principalId: approver.id, now: 11_500 })).rejects.toThrow(/must supersede/);
      expect(await getEffectiveEffectApproval(db, proposed.id)).toEqual(leaf);
    } finally {
      await close();
    }
  });
});
