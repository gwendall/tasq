import { afterEach, describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthorizationDecision } from "@tasq-internal/authority";
import {
  SIGNED_STATEMENT_PURPOSES,
  buildReplicationPushRequest,
  appendArtifact,
  createPrincipal,
  createLocalTasq,
  getReplicationAuthority,
  getSignedStatementProof,
  initializeLocalReplica,
  openDb,
  queueReplicatedCommitmentCreate,
  runKernelMigrations,
} from "@tasq-run/core";
import {
  ED25519_STATEMENT_PROFILE_URI,
  signPurposeBoundStatement,
} from "@tasq-run/extension-sdk";
import {
  canonicalizeEffectJson,
  type SigningCredentialV1,
} from "@tasq-run/schema";
import {
  HOSTED_CORE_OPERATIONS,
  HostedMutationError,
  createHostedCoreWorkspace,
  type HostedMutationCommand,
} from "../src/index.js";

const NOW = 1_910_000_000_000;
const WORKSPACE = "robotics/team-a";
const sha = (value: string) => `sha256:${value.repeat(64)}`;
const digest = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const roots: string[] = [];
let commandNumber = 0;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function command(
  operationId: string,
  input: unknown,
  options: {
    actor?: string;
    resourceKind?: "workspace" | "commitment" | "resource" | "replica";
    resourceId?: string;
    expectedRevision?: number | null;
    idempotencyKey?: string;
    requestDigest?: string;
  } = {},
): HostedMutationCommand {
  commandNumber += 1;
  const operation = HOSTED_CORE_OPERATIONS.find(({ id }) => id === operationId);
  if (!operation) throw new Error(`missing operation ${operationId}`);
  const actor = options.actor ?? "agent:builder";
  const resource = {
    kind: options.resourceKind ?? (operationId === "commitment.propose" ? "workspace" : "commitment"),
    id: options.resourceId ?? WORKSPACE,
  } as const;
  const requestDigest = options.requestDigest ?? sha((commandNumber % 10).toString());
  const idempotencyKey = options.idempotencyKey ?? `request-${commandNumber}`;
  const decision: AuthorizationDecision = {
    contractVersion: "tasq.authorization-decision.v1",
    decisionId: sha("a"),
    requestId: `authority-${commandNumber}`,
    workspaceId: WORKSPACE,
    evaluatedAt: NOW,
    subjectPrincipalId: actor,
    actorPrincipalId: actor,
    actionUri: operation.actionUri,
    resourceKind: resource.kind,
    resourceId: resource.id,
    decision: "allow",
    reasonCode: "allowed",
    grantIds: ["grant"],
    permissionSetDigests: [sha("b")],
    policyImplementationDigest: sha("c"),
    requestDigest: sha("d"),
  };
  return {
    contractVersion: "tasq.hosted-mutation-command.v1",
    operation,
    workspaceId: WORKSPACE,
    resource,
    expectedRevision: options.expectedRevision ?? null,
    input,
    requestDigest,
    idempotencyKey,
    idempotencyKeyDigest: digest(idempotencyKey),
    evaluatedAt: NOW,
    authorityRevision: 7,
    decision,
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tasq-hosted-workspace-"));
  roots.push(root);
  const workspace = await createHostedCoreWorkspace({
    workspaceId: WORKSPACE,
    databaseUrl: `file:${join(root, "domain.sqlite")}`,
    receiptDatabaseUrl: `file:${join(root, "receipts.sqlite")}`,
    clock: { now: () => NOW },
  });
  return { root, workspace };
}

describe("hosted Core workspace adapter", () => {
  test("runs real Core mutations, durable exact replay and stable cursor pagination", async () => {
    const { workspace } = await fixture();
    try {
      const firstCommand = command("commitment.propose", { title: "Alpha" }, {
        idempotencyKey: "create-alpha",
        requestDigest: sha("1"),
      });
      const first = await workspace.executeMutation(firstCommand);
      expect(first).toMatchObject({
        resultType: "commitment",
        resultRevision: 1,
        replayed: false,
      });
      const replay = await workspace.executeMutation(firstCommand);
      expect(replay).toEqual({ ...first, replayed: true });

      await expect(workspace.executeMutation({
        ...firstCommand,
        requestDigest: sha("2"),
        input: { title: "Changed under same key" },
      })).rejects.toEqual(expect.objectContaining({ code: "conflict" }));

      await workspace.executeMutation(command("commitment.propose", { title: "Beta" }));
      await workspace.executeMutation(command("commitment.propose", { title: "Gamma" }));
      const page1 = await workspace.listCommitments({ cursor: null, limit: 2 });
      expect(page1.items).toHaveLength(2);
      expect(page1.nextCursor).not.toBeNull();
      const page2 = await workspace.listCommitments({ cursor: page1.nextCursor, limit: 2 });
      expect(page2.items).toHaveLength(1);
      const ids = [...page1.items, ...page2.items].map(({ id }) => id);
      expect(new Set(ids).size).toBe(3);
      expect((await workspace.getCommitment(first.resultId))?.title).toBe("Alpha");
      expect((await workspace.listEventMetadata({ afterSequence: 0, limit: 100 })).items.length)
        .toBeGreaterThanOrEqual(3);
    } finally {
      await workspace.close();
    }
  });

  test("preserves claim and generic resource contention across principals", async () => {
    const { workspace } = await fixture();
    try {
      const created = await workspace.executeMutation(command("commitment.propose", { title: "Contended" }));
      const claim = await workspace.executeMutation(command("claim.acquire", { leaseMs: 30_000 }, {
        actor: "agent:planner",
        resourceId: created.resultId,
      }));
      expect(claim.resultType).toBe("claim");
      await expect(workspace.executeMutation(command("claim.acquire", { leaseMs: 30_000 }, {
        actor: "agent:builder",
        resourceId: created.resultId,
      }))).rejects.toBeInstanceOf(HostedMutationError);

      const resource = await workspace.executeMutation(command("resource.acquire", { leaseMs: 30_000 }, {
        actor: "agent:planner",
        resourceKind: "resource",
        resourceId: "robotics/arm:left",
      }));
      expect(resource.resultType).toBe("resource_lease");
      await expect(workspace.executeMutation(command("resource.acquire", { leaseMs: 30_000 }, {
        actor: "agent:builder",
        resourceKind: "resource",
        resourceId: "robotics/arm:left",
      }))).rejects.toEqual(expect.objectContaining({ code: "conflict" }));
    } finally {
      await workspace.close();
    }
  });

  test("replays receipts after reopening the adapter", async () => {
    const { root, workspace } = await fixture();
    const original = command("commitment.propose", { title: "Survive restart" }, {
      idempotencyKey: "survive-restart",
      requestDigest: sha("7"),
    });
    const first = await workspace.executeMutation(original);
    await workspace.close();
    const reopened = await createHostedCoreWorkspace({
      workspaceId: WORKSPACE,
      databaseUrl: `file:${join(root, "domain.sqlite")}`,
      receiptDatabaseUrl: `file:${join(root, "receipts.sqlite")}`,
      clock: { now: () => NOW },
    });
    try {
      expect(await reopened.executeMutation(original)).toEqual({ ...first, replayed: true });
      expect((await reopened.listCommitments({ cursor: null, limit: 10 })).items).toHaveLength(1);
    } finally {
      await reopened.close();
    }
  });

  test("binds completion proposals and human decisions to Core resolution services", async () => {
    const { root, workspace } = await fixture();
    try {
      const created = await workspace.executeMutation(command("commitment.propose", {
        title: "Validate hosted completion",
        successCriteria: "Observable hosted result exists",
        completionPolicy: "evidence",
        validationRequired: true,
      }));
      const evidence = await workspace.executeMutation(command("evidence.add", {
        kind: "report",
        summary: "Observable hosted result",
      }, { resourceId: created.resultId }));
      const local = await createLocalTasq({
        url: `file:${join(root, "domain.sqlite")}`,
        workspaceId: WORKSPACE,
        actor: "agent:builder",
        clock: { now: () => NOW },
      });
      const reviewer = await createLocalTasq({
        url: `file:${join(root, "domain.sqlite")}`,
        workspaceId: WORKSPACE,
        actor: "agent:reviewer",
        clock: { now: () => NOW },
      });
      const contract = await local.resolution.contracts.create({
        taskId: created.resultId,
        criteria: [{
          id: "result",
          statement: "Observable hosted result exists",
          acceptedEvidenceKinds: ["report"],
        }],
        policyKind: "attestation",
        policyUri: "urn:test:hosted-human-attestation",
        policyVersion: 1,
        implementationDigest: sha("9"),
        eligibleValidatorPrincipalIds: [reviewer.principalId],
      }, { idempotencyKey: "hosted-contract" });
      await reviewer.close();
      await local.close();

      const trust = await workspace.executeMutation(command("resolution.trust.attest-unverified", {
        evidenceId: evidence.resultId,
        reason: "Authenticated hosted actor recorded attribution only",
      }, { resourceId: created.resultId }));
      expect(trust.resultType).toBe("evidence_trust_record");
      const proposal = await workspace.executeMutation(command("resolution.proposal.create", {
        resolutionContractId: contract.id,
        criterionEvidence: [{ criterionId: "result", evidenceIds: [evidence.resultId] }],
        summary: "Ready for human approval",
      }, { resourceId: created.resultId }));
      expect(proposal.resultType).toBe("completion_proposal");
      const decision = await workspace.executeMutation(command("resolution.decision.attest", {
        proposalId: proposal.resultId,
        outcome: "accepted",
        reasonCode: "human_verified",
        explanation: "An authorized human reviewed the report",
      }, { resourceId: created.resultId, actor: "agent:reviewer" }));
      expect(decision).toMatchObject({
        resultType: "validation_decision",
        result: { outcome: "accepted", proposalId: proposal.resultId },
      });
    } finally {
      await workspace.close();
    }
  });

  test("accepts exact signed proof through the guarded operation and rejects a non-live credential", async () => {
    const root = await mkdtemp(join(tmpdir(), "tasq-hosted-signed-workspace-"));
    roots.push(root);
    const domainUrl = `file:${join(root, "domain.sqlite")}`;
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const publicMaterial = {
      format: "jwk-okp-ed25519" as const,
      x: publicKey.export({ format: "jwk" }).x!,
    };
    const materialDigest = `sha256:${createHash("sha256")
      .update(canonicalizeEffectJson(publicMaterial))
      .digest("hex")}` as const;
    let credential: SigningCredentialV1 = {
      credentialId: "credential:builder",
      workspaceId: WORKSPACE,
      principalId: "agent:builder",
      profileUri: ED25519_STATEMENT_PROFILE_URI,
      profileVersion: 1,
      publicMaterial,
      publicMaterialDigest: materialDigest,
      trustRootDigest: sha("7"),
      isolationClass: "isolated_process",
      status: "active",
      revision: 1,
      validFrom: new Date(NOW - 1_000).toISOString(),
      enrollmentMethod: "test-authority",
      enrollmentEvidenceDigest: sha("8"),
    };
    const workspace = await createHostedCoreWorkspace({
      workspaceId: WORKSPACE,
      databaseUrl: domainUrl,
      receiptDatabaseUrl: `file:${join(root, "receipts.sqlite")}`,
      clock: { now: () => NOW },
      signedStatements: {
        audience: "https://server.tasq.example/",
        acceptedTrustRootDigests: [credential.trustRootDigest],
        resolveCredential: async (id) => id === credential.credentialId ? credential : null,
      },
    });
    try {
      const created = await workspace.executeMutation(command("commitment.propose", {
        title: "Signed artifact",
      }));
      const local = await createLocalTasq({
        url: domainUrl,
        workspaceId: WORKSPACE,
        actor: "agent:builder",
        clock: { now: () => NOW },
      });
      await local.close();
      const opened = await openDb({ url: domainUrl, wal: true });
      const artifactDigest = sha("6");
      const artifact = await appendArtifact(opened.db, {
        tenantId: WORKSPACE,
        taskId: created.resultId,
        typeUri: "https://schemas.tasq.dev/subjects/artifact/v1",
        name: "result.json",
        digest: artifactDigest,
        inlineDataRef: "content-addressed:result",
      }, {
        tenantId: WORKSPACE,
        actor: "agent:builder",
        principalId: local.principalId,
        clock: { now: () => NOW },
        idempotencyKey: "artifact",
      });
      await opened.close();
      const payload = {
        contractVersion: "tasq.signed-statement.v1" as const,
        statementId: "statement:hosted:one",
        workspaceId: WORKSPACE,
        audience: "https://server.tasq.example/",
        issuerPrincipalId: credential.principalId,
        credentialId: credential.credentialId,
        purpose: { uri: SIGNED_STATEMENT_PURPOSES.artifact_authorship, version: 1 },
        subject: {
          typeUri: "https://schemas.tasq.dev/subjects/artifact/v1",
          id: artifact.id,
          digest: artifactDigest,
        },
        nonce: "nonce:hosted:one",
        issuedAt: new Date(NOW - 1).toISOString(),
        metadata: {},
      };
      const bundle = await signPurposeBoundStatement(payload, {
        credentialId: credential.credentialId,
        profileUri: ED25519_STATEMENT_PROFILE_URI,
        profileVersion: 1,
        allowedPurposeUris: [SIGNED_STATEMENT_PURPOSES.artifact_authorship],
        signStatement: ({ preAuthenticationEncoding }) =>
          sign(null, preAuthenticationEncoding, privateKey),
      });
      const acceptance = command("statement.accept", {
        bundle,
        binding: {
          bindingKind: "artifact_authorship",
          recordType: "artifact",
          recordId: artifact.id,
          recordDigest: artifactDigest,
        },
      }, {
        resourceKind: "workspace",
        resourceId: WORKSPACE,
        idempotencyKey: "accept-signed-one",
        requestDigest: sha("5"),
      });
      const accepted = await workspace.executeMutation(acceptance);
      expect(accepted).toMatchObject({
        resultType: "signed_statement_proof",
        resultId: payload.statementId,
        result: {
          statement: { statementId: payload.statementId },
          verification: { outcome: "valid" },
          binding: { bindingKind: "artifact_authorship" },
        },
      });
      expect(await workspace.executeMutation(acceptance)).toEqual({
        ...accepted,
        replayed: true,
      });

      const replicaId = "019e0000-0000-7000-8000-000000000001";
      const generationId = "019e0000-0000-7000-8000-000000000002";
      await workspace.executeMutation(command("replication.enroll", {
        generationId,
      }, {
        resourceKind: "replica",
        resourceId: replicaId,
        idempotencyKey: "enroll-offline-replica",
      }));
      const authorityDb = await openDb({ url: domainUrl, wal: true });
      const authorityIdentity = await getReplicationAuthority(
        authorityDb.db,
        WORKSPACE,
      );
      await authorityDb.close();
      if (!authorityIdentity) throw new Error("missing hosted replication authority");
      const offlineUrl = `file:${join(root, "offline.sqlite")}`;
      const offline = await openDb({ url: offlineUrl, wal: true });
      await runKernelMigrations(offline.client, { clock: { now: () => NOW } });
      await createPrincipal(offline.db, {
        id: "agent:builder",
        tenantId: WORKSPACE,
        kind: "agent",
        displayName: "agent:builder",
        status: "enabled",
      }, {
        tenantId: WORKSPACE,
        actor: "offline-bootstrap",
        clock: { now: () => NOW },
      });
      await initializeLocalReplica(offline.db, {
        workspaceId: WORKSPACE,
        replicaId,
        generationId,
        authorityReplicaId: authorityIdentity.authorityReplicaId,
        authorityEpoch: authorityIdentity.authorityEpoch,
        clock: { now: () => NOW },
      });
      await queueReplicatedCommitmentCreate(offline.db, {
        id: "019e0000-0000-7000-8000-000000000003",
        title: "Created while offline",
      }, {
        workspaceId: WORKSPACE,
        actor: "agent:builder",
        principalId: "agent:builder",
        clock: { now: () => NOW },
      });
      const pushRequest = await buildReplicationPushRequest(
        offline.db,
        WORKSPACE,
      );
      await offline.close();
      const operation = pushRequest.operations[0]!;
      const originPayload = {
        ...payload,
        statementId: "statement:replication:one",
        purpose: {
          uri: SIGNED_STATEMENT_PURPOSES.replication_operation_origin,
          version: 1,
        },
        subject: {
          typeUri: "https://schemas.tasq.dev/subjects/replication-operation/v1",
          id: operation.operationDigest,
          digest: operation.operationDigest as `sha256:${string}`,
        },
        nonce: "nonce:replication:one",
      };
      const originBundle = await signPurposeBoundStatement(originPayload, {
        credentialId: credential.credentialId,
        profileUri: ED25519_STATEMENT_PROFILE_URI,
        profileVersion: 1,
        allowedPurposeUris: [
          SIGNED_STATEMENT_PURPOSES.replication_operation_origin,
        ],
        signStatement: ({ preAuthenticationEncoding }) =>
          sign(null, preAuthenticationEncoding, privateKey),
      });
      const pushed = await workspace.executeMutation(command("replication.push", {
        request: pushRequest,
        signedOrigins: [originBundle],
      }, {
        resourceKind: "replica",
        resourceId: replicaId,
        idempotencyKey: "push-offline-one",
      }));
      expect(pushed).toMatchObject({
        resultType: "replication_push",
        result: {
          results: [{ disposition: "applied", operationDigest: operation.operationDigest }],
        },
      });
      const proofDb = await openDb({ url: domainUrl, wal: true });
      try {
        expect(await getSignedStatementProof(
          proofDb.db,
          originPayload.statementId,
          WORKSPACE,
        )).toMatchObject({
          bindings: [{
            bindingKind: "replication_operation_origin",
            recordId: operation.operationDigest,
          }],
        });
      } finally {
        await proofDb.close();
      }
      expect(await workspace.executeMutation(command("replication.pull", {
        generationId,
        cursor: null,
        limit: 10,
      }, {
        resourceKind: "replica",
        resourceId: replicaId,
        idempotencyKey: "pull-offline-one",
      }))).toMatchObject({
        resultType: "replication_pull",
        result: {
          disposition: "incremental",
          entries: [{ operationDigest: operation.operationDigest }],
        },
      });
      await expect(workspace.executeMutation(command("replication.push", {
        request: pushRequest,
        signedOrigins: [],
      }, {
        resourceKind: "replica",
        resourceId: replicaId,
        idempotencyKey: "unsigned-push-denied",
      }))).rejects.toBeInstanceOf(HostedMutationError);
      await expect(workspace.executeMutation(command("replication.push", {
        request: pushRequest,
        signedOrigins: [originBundle],
      }, {
        actor: "agent:other",
        resourceKind: "replica",
        resourceId: replicaId,
        idempotencyKey: "foreign-principal-push-denied",
      }))).rejects.toBeInstanceOf(HostedMutationError);

      credential = { ...credential, status: "revoked", revision: 2 };
      const revokedPayload = {
        ...payload,
        statementId: "statement:hosted:revoked",
        nonce: "nonce:hosted:revoked",
      };
      const revokedBundle = await signPurposeBoundStatement(revokedPayload, {
        credentialId: credential.credentialId,
        profileUri: ED25519_STATEMENT_PROFILE_URI,
        profileVersion: 1,
        allowedPurposeUris: [SIGNED_STATEMENT_PURPOSES.artifact_authorship],
        signStatement: ({ preAuthenticationEncoding }) =>
          sign(null, preAuthenticationEncoding, privateKey),
      });
      await expect(workspace.executeMutation(command("statement.accept", {
        bundle: revokedBundle,
        binding: {
          bindingKind: "artifact_authorship",
          recordType: "artifact",
          recordId: artifact.id,
          recordDigest: artifactDigest,
        },
      }, {
        resourceKind: "workspace",
        resourceId: WORKSPACE,
      }))).rejects.toBeInstanceOf(HostedMutationError);
    } finally {
      await workspace.close();
    }
  });
});
