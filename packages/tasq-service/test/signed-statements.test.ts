import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ED25519_STATEMENT_PROFILE_URI,
  ED25519_VERIFIER_IMPLEMENTATION_DIGEST,
  signPurposeBoundStatement,
  verifyPurposeBoundStatement,
} from "@tasq-run/extension-sdk";
import {
  canonicalizeEffectJson,
  type SigningCredentialV1,
} from "@tasq-run/schema";
import {
  SIGNED_STATEMENT_PURPOSES,
  acceptSignedStatement,
  appendArtifact,
  createCommitment,
  createPrincipal,
  diagnoseStore,
  openDb,
  runMigrations,
} from "../src/index.js";

const roots: string[] = [];
setDefaultTimeout(30_000);
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

const digest = (value: unknown) =>
  `sha256:${createHash("sha256").update(
    canonicalizeEffectJson(value as never),
  ).digest("hex")}` as const;

describe("signed statement doctor integration", () => {
  test("accepts intact public proof and detects snapshot tampering after SQLite guards are bypassed", async () => {
    const root = mkdtempSync(join(tmpdir(), "tasq-signed-doctor-"));
    roots.push(root);
    const opened = await openDb({
      url: `file:${join(root, "db.sqlite")}`,
      wal: false,
    });
    const workspaceId = "doctor/signed";
    const now = 1_920_000_000_000;
    try {
      await runMigrations(opened.client, { now });
      const principal = await createPrincipal(opened.db, {
        tenantId: workspaceId,
        kind: "agent",
        displayName: "Signer",
      }, { tenantId: workspaceId, actor: "test", now });
      const commitment = await createCommitment(opened.db, {
        title: "Inspect signed proof",
      }, {
        workspaceId,
        actor: "test",
        principalId: principal.id,
        now,
      });
      const artifactDigest = `sha256:${"a".repeat(64)}` as const;
      const artifact = await appendArtifact(opened.db, {
        tenantId: workspaceId,
        taskId: commitment.id,
        typeUri: "https://schemas.tasq.dev/subjects/artifact/v1",
        name: "proof.json",
        digest: artifactDigest,
        inlineDataRef: "content-addressed:proof",
      }, {
        tenantId: workspaceId,
        actor: "test",
        principalId: principal.id,
        now,
      });
      const { privateKey, publicKey } = generateKeyPairSync("ed25519");
      const publicMaterial = {
        format: "jwk-okp-ed25519" as const,
        x: publicKey.export({ format: "jwk" }).x!,
      };
      const credential: SigningCredentialV1 = {
        credentialId: "credential:doctor",
        workspaceId,
        principalId: principal.id,
        profileUri: ED25519_STATEMENT_PROFILE_URI,
        profileVersion: 1,
        publicMaterial,
        publicMaterialDigest: digest(publicMaterial),
        trustRootDigest: `sha256:${"b".repeat(64)}`,
        isolationClass: "isolated_process",
        status: "active",
        revision: 1,
        validFrom: new Date(now - 1_000).toISOString(),
        enrollmentMethod: "test",
        enrollmentEvidenceDigest: `sha256:${"c".repeat(64)}`,
      };
      const bundle = await signPurposeBoundStatement({
        contractVersion: "tasq.signed-statement.v1",
        statementId: "statement:doctor",
        workspaceId,
        audience: "https://server.tasq.example/",
        issuerPrincipalId: principal.id,
        credentialId: credential.credentialId,
        purpose: {
          uri: SIGNED_STATEMENT_PURPOSES.artifact_authorship,
          version: 1,
        },
        subject: {
          typeUri: "https://schemas.tasq.dev/subjects/artifact/v1",
          id: artifact.id,
          digest: artifactDigest,
        },
        nonce: "nonce:doctor",
        issuedAt: new Date(now - 1).toISOString(),
        metadata: {},
      }, {
        credentialId: credential.credentialId,
        profileUri: ED25519_STATEMENT_PROFILE_URI,
        profileVersion: 1,
        allowedPurposeUris: [SIGNED_STATEMENT_PURPOSES.artifact_authorship],
        signStatement: ({ preAuthenticationEncoding }) =>
          sign(null, preAuthenticationEncoding, privateKey),
      });
      await acceptSignedStatement(opened.db, {
        bundle,
        expectedAudience: "https://server.tasq.example/",
        binding: {
          bindingKind: "artifact_authorship",
          recordType: "artifact",
          recordId: artifact.id,
          recordDigest: artifactDigest,
        },
        verify: async (request) => ({
          ...await verifyPurposeBoundStatement({
            ...request,
            resolveCredential: () => credential,
          }),
          verifierImplementationDigest: ED25519_VERIFIER_IMPLEMENTATION_DIGEST,
        }),
      }, { tenantId: workspaceId, actor: "server", now });

      expect(await diagnoseStore(opened.db, opened.client, workspaceId))
        .toMatchObject({ ok: true, issues: [] });
      await expect(opened.client.execute(
        "UPDATE accepted_signing_credential_snapshot SET public_material_digest = 'sha256:tampered'",
      )).rejects.toThrow("immutable");
      await opened.client.execute(
        "DROP TRIGGER accepted_signing_credential_no_update",
      );
      await opened.client.execute(
        "UPDATE accepted_signing_credential_snapshot SET public_material_digest = 'sha256:tampered'",
      );
      expect((await diagnoseStore(opened.db, opened.client, workspaceId)).issues)
        .toContainEqual(expect.objectContaining({
          code: "accepted_signing_credential_snapshot_invalid",
          entityType: "signing_credential_snapshot",
        }));
    } finally {
      await opened.close();
    }
  });
});
