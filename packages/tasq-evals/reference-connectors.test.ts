/** TQ-306: separately packaged read/effect connectors against the unmodified kernel. */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bindVerifiedEffectReceipt,
  createHmacProviderReceiptAuthenticator,
  createReferenceWorkItemEffectConnector,
  createReferenceWorkItemReadConnector,
  PROVIDER_RECEIPT_COVERAGE,
  sha256,
  WORK_ITEM_COMMENT_CONTRACT_DIGEST,
  WORK_ITEM_COMMENT_EFFECT_TYPE_URI,
  WORK_ITEM_COMMENT_OPERATION_URI,
  type ProviderCommentReceipt,
  type ProviderCommentReceiptPayload,
  type ProviderWorkItemSnapshot,
  type WorkItemProviderClient,
} from "@tasq-internal/reference-connectors";
import { createHmacEffectPermitAuthenticator } from "@tasq-run/extension-sdk";
import { createMutableClock, type EffectJsonObject } from "@tasq-run/schema";
import {
  acquireTaskClaim,
  authorizeEffect,
  beginEffectExecution,
  createCommitment,
  createPrincipal,
  getCommitment,
  getEffect,
  inspectCommitment,
  openDb,
  proposeEffect,
  recordEffectApproval,
  recordEffectReceipt,
  runKernelMigrations,
  startTaskAttempt,
} from "@tasq-run/core";
import { installExtension } from "@tasq-internal/local-service";

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

const WORKSPACE = "tq-306-reference-connectors";
const ACCOUNT = "robotics-team";
const PROJECT = "arm-controller";
const ITEM = "calibration-42";
const INSTANCE = "connector:reference-work-items:robotics-team";
const BINDING = `sha256:${"b".repeat(64)}`;
const BODY = "Calibration completed; logs are attached.";
const BODY_BYTES = new TextEncoder().encode(BODY);
const BODY_DIGEST = sha256(BODY_BYTES);
const permitAuthenticator = createHmacEffectPermitAuthenticator("tq306-permit-key", "p".repeat(32));
const receiptAuthenticator = createHmacProviderReceiptAuthenticator("tq306-provider-key", "r".repeat(32));

class ReferenceProvider implements WorkItemProviderClient {
  readonly operations = new Map<string, ProviderCommentReceipt>();
  constructor(private readonly now: () => number) {}

  async readWorkItem(): Promise<ProviderWorkItemSnapshot> {
    return {
      accountRef: ACCOUNT,
      projectRef: PROJECT,
      itemRef: ITEM,
      version: "provider-version-7",
      state: "open",
      title: "Sensitive calibration incident title",
      updatedAt: this.now() - 10,
      recordRef: `https://provider.example/projects/${PROJECT}/items/${ITEM}`,
    };
  }

  async createComment(input: Parameters<WorkItemProviderClient["createComment"]>[0]): Promise<ProviderCommentReceipt> {
    const prior = this.operations.get(input.dispatchIdempotencyKey);
    if (prior) return prior;
    const payload: ProviderCommentReceiptPayload = {
      accountRef: ACCOUNT,
      projectRef: input.projectRef,
      itemRef: input.itemRef,
      dispatchIdempotencyKey: input.dispatchIdempotencyKey,
      requestDigest: input.requestDigest,
      providerOperationId: `comment-operation:${this.operations.size + 1}`,
      outcome: "committed",
      occurredAt: this.now(),
      receiptId: `comment-receipt:${this.operations.size + 1}`,
      rawRef: `https://provider.example/receipts/${this.operations.size + 1}`,
      coverage: [...PROVIDER_RECEIPT_COVERAGE],
    };
    const receipt = { payload, proof: receiptAuthenticator.sign(payload) };
    this.operations.set(input.dispatchIdempotencyKey, receipt);
    return receipt;
  }

  async lookupComment(dispatchIdempotencyKey: string): Promise<ProviderCommentReceipt | null> {
    return this.operations.get(dispatchIdempotencyKey) ?? null;
  }
}

describe("TQ-306 reference connector acceptance", () => {
  test("an unknown runtime reads a fact and performs one authorized provider write without implicit completion", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tasq-tq306-"));
    tmpDirs.push(dir);
    const handle = await openDb({ url: `file:${join(dir, "db.sqlite")}`, wal: false });
    const clock = createMutableClock(100_000);
    try {
      await runKernelMigrations(handle.client, { clock });
      const provider = new ReferenceProvider(() => clock.now());
      const readConnector = createReferenceWorkItemReadConnector({
        instanceRef: "connector:reference-work-item-reader:robotics-team",
        bindingDigest: BINDING,
        providerIssuerUri: "https://provider.example",
        providerAccountRef: ACCOUNT,
        providerAudience: "work-items:robotics-team",
        client: provider,
      });
      const observation = await readConnector.observe({ projectRef: PROJECT, itemRef: ITEM });
      expect(observation.payload).toMatchObject({
        providerAccountRef: ACCOUNT,
        projectRef: PROJECT,
        itemRef: ITEM,
        state: "open",
      });
      expect(JSON.stringify(observation)).not.toContain("Sensitive calibration incident title");

      const worker = await createPrincipal(handle.db, {
        tenantId: WORKSPACE,
        kind: "runtime",
        displayName: "Reference connector worker",
      }, { tenantId: WORKSPACE, clock });
      clock.advance(1);
      const approver = await createPrincipal(handle.db, {
        tenantId: WORKSPACE,
        kind: "human",
        displayName: "Authenticated operator",
      }, { tenantId: WORKSPACE, clock });
      clock.advance(1);
      await installExtension(handle.db, {
        extensionUri: "https://schemas.tasq.dev/extensions/reference-work-item-effects",
        version: "1.0.0",
        types: [{
          recordKind: "effect",
          typeUri: WORK_ITEM_COMMENT_EFFECT_TYPE_URI,
          schemaVersion: 1,
          schema: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            additionalProperties: false,
          },
        }],
        evaluators: [],
      }, { tenantId: WORKSPACE, actor: "reference-connector-host", clock });
      clock.advance(1);

      const effectConnector = createReferenceWorkItemEffectConnector({
        instanceRef: INSTANCE,
        bindingDigest: BINDING,
        providerIssuerUri: "https://provider.example",
        providerAccountRef: ACCOUNT,
        providerAudience: "work-items:robotics-team",
        providerIdempotencyRetentionMs: 86_400_000,
        maxBodyBytes: 4_096,
        client: provider,
        receiptVerifier: receiptAuthenticator,
        permitVerifier: permitAuthenticator,
        clock,
        resolveBody: (reference) => {
          if (reference !== "urn:artifact:calibration-comment:1") throw new Error("Unknown body reference");
          return BODY_BYTES;
        },
      });
      const commitment = await createCommitment(handle.db, {
        title: "Post the reviewed calibration result",
        completionPolicy: "evidence",
        successCriteria: "A verified provider receipt is reviewed separately",
      }, {
        workspaceId: WORKSPACE,
        actor: "reference-connector-host",
        principalId: worker.id,
        clock,
      });
      clock.advance(1);
      const claim = await acquireTaskClaim(handle.db, commitment.id, {
        tenantId: WORKSPACE,
        principalId: worker.id,
        leaseMs: 10_000,
        clock,
      });
      clock.advance(1);
      const attempt = await startTaskAttempt(handle.db, commitment.id, {
        tenantId: WORKSPACE,
        principalId: worker.id,
        claimId: claim.id,
        occurredAt: clock.now(),
        clock,
      });
      clock.advance(1);
      const parameters: EffectJsonObject = {
        providerAccountRef: ACCOUNT,
        projectRef: PROJECT,
        itemRef: ITEM,
        bodyRef: "urn:artifact:calibration-comment:1",
        bodyDigest: BODY_DIGEST,
        bodyBytes: BODY_BYTES.byteLength,
      };
      const proposed = await proposeEffect(handle.db, {
        tenantId: WORKSPACE,
        taskId: commitment.id,
        attemptId: attempt.id,
        request: {
          protocol: "tasq.effect-request.v1",
          canonicalization: "tasq.jcs-safe-integer.v1",
          digestAlgorithm: "sha-256",
          workspaceId: WORKSPACE,
          effectTypeUri: WORK_ITEM_COMMENT_EFFECT_TYPE_URI,
          effectSchemaVersion: 1,
          connector: {
            operationUri: WORK_ITEM_COMMENT_OPERATION_URI,
            operationVersion: 1,
            contractDigest: WORK_ITEM_COMMENT_CONTRACT_DIGEST,
            instanceRef: INSTANCE,
            bindingDigest: BINDING,
          },
          parameters,
          secretBindings: [],
        },
      }, { tenantId: WORKSPACE, principalId: worker.id, clock });
      clock.advance(1);
      const approval = await recordEffectApproval(handle.db, {
        tenantId: WORKSPACE,
        effectId: proposed.id,
        decision: "approved",
        scope: {
          providerAccountRef: ACCOUNT,
          projectRef: PROJECT,
          itemRef: ITEM,
          bodyDigest: BODY_DIGEST,
        },
        limits: { maxBodyBytes: 4_096 },
        expiresAt: clock.now() + 5_000,
      }, {
        tenantId: WORKSPACE,
        principalId: approver.id,
        authorityVerification: {
          level: "cryptographic",
          method: "tq306-authenticated-approval",
          details: { keyId: "operator-key:1" },
        },
        clock,
      });
      clock.advance(1);
      const authorized = await authorizeEffect(handle.db, proposed.id, approval.id, {
        tenantId: WORKSPACE,
        principalId: worker.id,
        expectedRevision: proposed.revision,
        clock,
      });
      clock.advance(1);
      const begun = await beginEffectExecution(handle.db, authorized.id, {
        tenantId: WORKSPACE,
        principalId: worker.id,
        expectedRevision: authorized.revision,
        claimId: claim.id,
        fence: claim.fence,
        policy: effectConnector.policy,
        permitIssuer: permitAuthenticator,
        clock,
      });

      const first = await effectConnector.dispatch(begun.permit);
      const replay = await effectConnector.dispatch(begun.permit);
      expect(replay.providerOperationId).toBe(first.providerOperationId);
      expect(provider.operations.size).toBe(1);
      const verified = effectConnector.verifyReceipt(first.report);
      const receipt = await recordEffectReceipt(handle.db, { report: first.report }, {
        tenantId: WORKSPACE,
        principalId: worker.id,
        expectedRevision: begun.effect.revision,
        verifier: bindVerifiedEffectReceipt(first.report, verified),
        clock,
      });

      expect((await getEffect(handle.db, begun.effect.id, WORKSPACE))?.status).toBe("committed");
      expect((await getCommitment(handle.db, commitment.id, WORKSPACE))?.status).toBe("open");
      const inspected = await inspectCommitment(handle.db, commitment.id, {
        workspaceId: WORKSPACE,
        clock,
      });
      expect(inspected?.effectReceipts[0]).toMatchObject({
        id: receipt.id,
        effectId: begun.effect.id,
        report: { outcome: "committed" },
      });
      expect(inspected?.evidence).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: receipt.evidenceId, kind: "effect_receipt" }),
      ]));
    } finally {
      await handle.close();
    }
  });
});
