import { afterEach, describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ED25519_STATEMENT_PROFILE_URI,
  ED25519_VERIFIER_IMPLEMENTATION_DIGEST,
  signPurposeBoundStatement,
  verifyPurposeBoundStatement,
} from "@tasq-run/extension-sdk";
import { canonicalizeEffectJson, type SigningCredentialV1 } from "@tasq-run/schema";
import {
  SIGNED_STATEMENT_PURPOSES,
  acceptSignedStatement,
  appendArtifact,
  createPortableWorkspaceCheckpoint,
  createLocalTasq,
  exportPortableStore,
  getSignedStatementProof,
  importPortableStore,
  installExtension,
  inspectCommitment,
  listSignedStatementBindings,
  openDb,
  proposeEffect,
  recordEffectApproval,
} from "../src/kernel.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));
const sha = (value: unknown) =>
  `sha256:${createHash("sha256").update(canonicalizeEffectJson(value as never)).digest("hex")}` as const;

describe("TQ-615 signed statement persistence and typed binding", () => {
  test("atomically stores exact proof, verification, nonce and artifact-authorship binding", async () => {
    const root = await mkdtemp(join(tmpdir(), "tasq-signed-proof-"));
    roots.push(root);
    const url = `file:${join(root, "db.sqlite")}`;
    const now = 1_900_000_000_000;
    const clock = { now: () => now };
    const client = await createLocalTasq({ url, workspaceId: "team/acme", actor: "author", clock });
    const commitment = await client.commitments.create({ title: "Publish report" }, { idempotencyKey: "task" });
    const validationCommitment = await client.commitments.create({
      title: "Validate report",
      successCriteria: "Report evidence exists",
      completionPolicy: "evidence",
      validationRequired: true,
    }, { idempotencyKey: "validation-task" });
    const validationEvidence = await client.evidence.add({
      taskId: validationCommitment.id,
      kind: "artifact",
      summary: "Report evidence exists",
    }, { idempotencyKey: "validation-evidence" });
    const resolutionContract = await client.resolution.contracts.create({
      taskId: validationCommitment.id,
      criteria: [{
        id: "report",
        statement: "Report evidence exists",
        acceptedEvidenceKinds: ["artifact"],
      }],
      policyKind: "attestation",
      policyUri: "urn:tasq:test:signed-attestation",
      policyVersion: 1,
      implementationDigest: `sha256:${"4".repeat(64)}`,
      eligibleValidatorPrincipalIds: [client.principalId],
    }, { idempotencyKey: "validation-contract" });
    const completionProposal = await client.resolution.proposals.create({
      taskId: validationCommitment.id,
      resolutionContractId: resolutionContract.id,
      criterionEvidence: [{
        criterionId: "report",
        evidenceIds: [validationEvidence.id],
      }],
    }, { idempotencyKey: "validation-proposal" });
    const corePrincipalId = client.principalId;
    await client.close();
    const opened = await openDb({ url, wal: false });
    try {
      const artifactDigest = `sha256:${"c".repeat(64)}` as const;
      const artifact = await appendArtifact(opened.db, {
        tenantId: "team/acme", taskId: commitment.id,
        typeUri: "https://schemas.tasq.dev/subjects/artifact/v1",
        name: "report.json", digest: artifactDigest,
        inlineDataRef: "content-addressed:report",
      }, { actor: "author", clock, idempotencyKey: "artifact" });
      const { privateKey, publicKey } = generateKeyPairSync("ed25519");
      const publicMaterial = { format: "jwk-okp-ed25519", x: publicKey.export({ format: "jwk" }).x! };
      const credential: SigningCredentialV1 = {
        credentialId: "credential-1", workspaceId: "team/acme",
        principalId: "principal:author", profileUri: ED25519_STATEMENT_PROFILE_URI,
        profileVersion: 1, publicMaterial, publicMaterialDigest: sha(publicMaterial),
        trustRootDigest: `sha256:${"a".repeat(64)}`, isolationClass: "isolated_process",
        status: "active", revision: 1, validFrom: "2026-03-01T00:00:00.000Z",
        enrollmentMethod: "host-proof", enrollmentEvidenceDigest: `sha256:${"b".repeat(64)}`,
      };
      const payload = {
        contractVersion: "tasq.signed-statement.v1" as const,
        statementId: "statement-1", workspaceId: "team/acme",
        audience: "https://server.tasq.example/", issuerPrincipalId: credential.principalId,
        credentialId: credential.credentialId,
        purpose: { uri: SIGNED_STATEMENT_PURPOSES.artifact_authorship, version: 1 },
        subject: {
          typeUri: "https://schemas.tasq.dev/subjects/artifact/v1",
          id: artifact.id, digest: artifactDigest,
        },
        nonce: "nonce-1", issuedAt: "2030-03-17T17:46:39.000Z", metadata: {},
      };
      const bundle = await signPurposeBoundStatement(payload, {
        credentialId: credential.credentialId, profileUri: ED25519_STATEMENT_PROFILE_URI,
        profileVersion: 1, allowedPurposeUris: [SIGNED_STATEMENT_PURPOSES.artifact_authorship],
        signStatement: ({ preAuthenticationEncoding }) => sign(null, preAuthenticationEncoding, privateKey),
      });
      const verify = async (request: {
        bundle: typeof bundle; expectedWorkspaceId: string; expectedAudience: string; acceptanceTime: string;
      }) => ({
        ...await verifyPurposeBoundStatement({
          ...request, resolveCredential: () => credential,
        }),
        verifierImplementationDigest: ED25519_VERIFIER_IMPLEMENTATION_DIGEST,
      });
      const acceptFor = async (input: {
        statementId: string;
        nonce: string;
        purpose: keyof typeof SIGNED_STATEMENT_PURPOSES;
        subjectTypeUri: string;
        subjectId: string;
        subjectDigest: `sha256:${string}`;
        recordType: string;
        recordId: string;
      }, targetDb = opened.db) => {
        const statementPayload = {
          ...payload,
          statementId: input.statementId,
          purpose: { uri: SIGNED_STATEMENT_PURPOSES[input.purpose], version: 1 },
          subject: {
            typeUri: input.subjectTypeUri,
            id: input.subjectId,
            digest: input.subjectDigest,
          },
          nonce: input.nonce,
        };
        const statementBundle = await signPurposeBoundStatement(statementPayload, {
          credentialId: credential.credentialId,
          profileUri: ED25519_STATEMENT_PROFILE_URI,
          profileVersion: 1,
          allowedPurposeUris: [SIGNED_STATEMENT_PURPOSES[input.purpose]],
          signStatement: ({ preAuthenticationEncoding }) =>
            sign(null, preAuthenticationEncoding, privateKey),
        });
        return acceptSignedStatement(targetDb, {
          bundle: statementBundle,
          expectedAudience: payload.audience,
          binding: {
            bindingKind: input.purpose,
            recordType: input.recordType,
            recordId: input.recordId,
            recordDigest: input.subjectDigest,
          },
          verify,
        }, { tenantId: "team/acme", actor: "server", clock });
      };
      const accepted = await acceptSignedStatement(opened.db, {
        bundle, expectedAudience: payload.audience,
        binding: {
          bindingKind: "artifact_authorship", recordType: "artifact",
          recordId: artifact.id, recordDigest: artifactDigest,
        },
        verify,
      }, { tenantId: "team/acme", actor: "server", clock });
      expect(accepted).toMatchObject({
        statement: { statementId: "statement-1", payload },
        verification: { outcome: "valid", credentialStateAtVerification: "active" },
        binding: { bindingKind: "artifact_authorship", recordId: artifact.id },
      });
      const inspection = await inspectCommitment(opened.db, commitment.id, {
        workspaceId: "team/acme",
        clock,
      });
      expect(inspection?.signedStatementProofs).toMatchObject([{
        statement: { statementId: "statement-1" },
        assurance: {
          signature: "valid_at_acceptance",
          currentCredentialState: "not_asserted_by_workspace_store",
          semanticTruth: "not_asserted_by_signature",
          authorization: "not_granted_by_signature",
        },
      }]);
      expect(await acceptSignedStatement(opened.db, {
        bundle, expectedAudience: payload.audience,
        binding: {
          bindingKind: "artifact_authorship", recordType: "artifact",
          recordId: artifact.id, recordDigest: artifactDigest,
        },
        verify,
      }, { tenantId: "team/acme", actor: "server", clock })).toEqual(accepted);
      await expect(acceptFor({
        statementId: "statement-1",
        nonce: "nonce-statement-id-reuse",
        purpose: "artifact_authorship",
        subjectTypeUri: "https://schemas.tasq.dev/subjects/artifact/v1",
        subjectId: artifact.id,
        subjectDigest: artifactDigest,
        recordType: "artifact",
        recordId: artifact.id,
      })).rejects.toThrow("statement identity reused");
      await expect(acceptFor({
        statementId: "statement-nonce-reuse",
        nonce: "nonce-1",
        purpose: "artifact_authorship",
        subjectTypeUri: "https://schemas.tasq.dev/subjects/artifact/v1",
        subjectId: artifact.id,
        subjectDigest: artifactDigest,
        recordType: "artifact",
        recordId: artifact.id,
      })).rejects.toThrow();

      const raceInputs = ["a", "b"].map((suffix) => ({
        statementId: `statement-nonce-race-${suffix}`,
        nonce: "nonce-race",
        purpose: "artifact_authorship" as const,
        subjectTypeUri: "https://schemas.tasq.dev/subjects/artifact/v1",
        subjectId: artifact.id,
        subjectDigest: artifactDigest,
        recordType: "artifact",
        recordId: artifact.id,
      }));
      const raced = await Promise.allSettled([
        acceptFor(raceInputs[0]!),
        acceptFor(raceInputs[1]!),
      ]);
      expect(raced.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
      expect(raced.filter(({ status }) => status === "rejected")).toHaveLength(1);
      await expect(opened.client.execute({
        sql: "UPDATE signed_statement SET purpose_uri = 'https://evil.example/' WHERE statement_id = ?",
        args: [payload.statementId],
      })).rejects.toThrow("immutable");
      await expect(acceptSignedStatement(opened.db, {
        bundle, expectedAudience: payload.audience,
        binding: {
          bindingKind: "effect_approval", recordType: "effect_approval",
          recordId: artifact.id, recordDigest: artifactDigest,
        },
        verify,
      }, { tenantId: "team/acme", actor: "server", clock })).rejects.toThrow("purpose");

      await acceptFor({
        statementId: "statement-artifact-acceptance",
        nonce: "nonce-artifact-acceptance",
        purpose: "artifact_acceptance",
        subjectTypeUri: "https://schemas.tasq.dev/subjects/artifact/v1",
        subjectId: artifact.id,
        subjectDigest: artifactDigest,
        recordType: "artifact",
        recordId: artifact.id,
      });
      await acceptFor({
        statementId: "statement-completion",
        nonce: "nonce-completion",
        purpose: "completion_attestation",
        subjectTypeUri: "https://schemas.tasq.dev/subjects/completion-proposal/v1",
        subjectId: completionProposal.id,
        subjectDigest: completionProposal.proposalDigest as `sha256:${string}`,
        recordType: "completion_proposal",
        recordId: completionProposal.id,
      });

      await installExtension(opened.db, {
        extensionUri: "https://example.test/extensions/signed-effects",
        version: "1.0.0",
        types: [{
          recordKind: "effect",
          typeUri: "https://example.test/effects/publish",
          schemaVersion: 1,
          schema: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            additionalProperties: false,
            properties: { artifactId: { type: "string" } },
            required: ["artifactId"],
          },
        }],
        evaluators: [],
      }, { tenantId: "team/acme", actor: "server", clock });
      const effect = await proposeEffect(opened.db, {
        tenantId: "team/acme",
        taskId: commitment.id,
        request: {
          protocol: "tasq.effect-request.v1",
          canonicalization: "tasq.jcs-safe-integer.v1",
          digestAlgorithm: "sha-256",
          workspaceId: "team/acme",
          effectTypeUri: "https://example.test/effects/publish",
          effectSchemaVersion: 1,
          connector: {
            operationUri: "https://example.test/connectors/publish",
            operationVersion: 1,
            contractDigest: `sha256:${"8".repeat(64)}`,
            instanceRef: "connector:publish:test",
            bindingDigest: `sha256:${"9".repeat(64)}`,
          },
          parameters: { artifactId: artifact.id },
          secretBindings: [],
        },
      }, { tenantId: "team/acme", actor: "server", clock });
      const approval = await recordEffectApproval(opened.db, {
        tenantId: "team/acme",
        effectId: effect.id,
        decision: "approved",
      }, {
        tenantId: "team/acme",
        actor: "server",
        principalId: corePrincipalId,
        clock,
        authorityVerification: {
          level: "authenticated_context",
          method: "test-authority",
          details: {},
        },
      });
      await acceptFor({
        statementId: "statement-effect-approval",
        nonce: "nonce-effect-approval",
        purpose: "effect_approval",
        subjectTypeUri: "https://schemas.tasq.dev/subjects/effect/v1",
        subjectId: effect.id,
        subjectDigest: effect.requestDigest as `sha256:${string}`,
        recordType: "effect_approval",
        recordId: approval.id,
      });

      const operationDigest = `sha256:${"f".repeat(64)}` as const;
      await opened.client.execute({
        sql: `INSERT INTO replication_accepted_operation(
          workspace_id, authority_sequence, replica_id, generation_id, counter,
          operation_digest, operation_json, disposition, result_json, recorded_at
        ) VALUES (?, 1, ?, ?, 1, ?, '{}', 'applied', '{}', ?)`,
        args: [
          "team/acme",
          "019d1000-0000-7000-8000-000000000001",
          "019d1000-0000-7000-8000-000000000002",
          operationDigest,
          now,
        ],
      });
      await acceptFor({
        statementId: "statement-replication",
        nonce: "nonce-replication",
        purpose: "replication_operation_origin",
        subjectTypeUri: "https://schemas.tasq.dev/subjects/replication-operation/v1",
        subjectId: operationDigest,
        subjectDigest: operationDigest,
        recordType: "replication_operation",
        recordId: operationDigest,
      });

      const checkpoint = await createPortableWorkspaceCheckpoint(opened.client, {
        workspaceId: "team/acme",
        authorityEpoch: "authority-epoch-1",
        createdByPrincipalId: credential.principalId,
        createdAt: now + 10,
      });
      const checkpointPayload = {
        ...payload,
        statementId: "statement-checkpoint-1",
        purpose: { uri: SIGNED_STATEMENT_PURPOSES.workspace_checkpoint, version: 1 },
        subject: {
          typeUri: "https://schemas.tasq.dev/subjects/workspace-checkpoint/v1",
          id: checkpoint.id,
          digest: checkpoint.rootDigest,
        },
        nonce: "nonce-checkpoint-1",
        issuedAt: new Date(now + 10).toISOString(),
      };
      const checkpointBundle = await signPurposeBoundStatement(checkpointPayload, {
        credentialId: credential.credentialId,
        profileUri: ED25519_STATEMENT_PROFILE_URI,
        profileVersion: 1,
        allowedPurposeUris: [SIGNED_STATEMENT_PURPOSES.workspace_checkpoint],
        signStatement: ({ preAuthenticationEncoding }) =>
          sign(null, preAuthenticationEncoding, privateKey),
      });
      await acceptSignedStatement(opened.db, {
        bundle: checkpointBundle,
        expectedAudience: payload.audience,
        binding: {
          bindingKind: "workspace_checkpoint",
          recordType: "workspace_checkpoint",
          recordId: checkpoint.id,
          recordDigest: checkpoint.rootDigest as `sha256:${string}`,
        },
        verify: async (request) => ({
          ...await verifyPurposeBoundStatement({
            ...request,
            resolveCredential: () => credential,
          }),
          verifierImplementationDigest: ED25519_VERIFIER_IMPLEMENTATION_DIGEST,
        }),
      }, { tenantId: "team/acme", actor: "server", clock: { now: () => now + 10 } });
      expect((await listSignedStatementBindings(
        opened.db,
        { tenantId: "team/acme" },
      )).map(({ bindingKind }) => bindingKind).sort()).toEqual([
        "artifact_acceptance",
        "artifact_authorship",
        "artifact_authorship",
        "completion_attestation",
        "effect_approval",
        "replication_operation_origin",
        "workspace_checkpoint",
      ]);

      const exported = await exportPortableStore(opened.client, "team/acme", {
        now: now + 20,
      });
      const serialized = JSON.stringify(exported.document);
      expect(serialized).not.toContain("statement-replication");
      const privateJwk = privateKey.export({ format: "jwk" });
      expect(serialized).not.toContain(privateJwk.d!);
      const importedPath = join(root, "imported.sqlite");
      await importPortableStore(
        exported.document,
        importedPath,
        exported.sha256,
        now + 30,
      );
      const imported = await openDb({ url: `file:${importedPath}`, wal: false });
      try {
        expect(await getSignedStatementProof(
          imported.db,
          "statement-checkpoint-1",
          "team/acme",
        )).toMatchObject({
          statement: { subjectId: checkpoint.id, subjectDigest: checkpoint.rootDigest },
          bindings: [{ bindingKind: "workspace_checkpoint", recordId: checkpoint.id }],
        });
      } finally {
        await imported.close();
      }
      const embedded = await createLocalTasq({
        url,
        workspaceId: "team/acme",
        actor: "reader",
        clock: { now: () => now + 40 },
        wal: false,
      });
      try {
        expect(await embedded.signedStatements.get("statement-1")).toMatchObject({
          statement: { statementId: "statement-1" },
          bindings: [{ bindingKind: "artifact_authorship" }],
        });
        expect(await embedded.signedStatements.listBindings({
          recordId: artifact.id,
        })).toHaveLength(3);
      } finally {
        await embedded.close();
      }
    } finally {
      await opened.close();
    }
  });
});
