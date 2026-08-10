import { afterEach, describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import {
  ED25519_STATEMENT_PROFILE_URI,
  ED25519_VERIFIER_IMPLEMENTATION_DIGEST,
  signPurposeBoundStatement,
  verifyPurposeBoundStatement,
} from "@tasq-run/extension-sdk";
import {
  StatementBinderDescriptorV1,
  artifact as artifactTable,
  canonicalizeEffectJson,
  type SignedStatementPayloadV1,
  type SigningCredentialV1,
} from "@tasq-run/schema";
import {
  acceptSignedStatement,
  appendArtifact,
  createLocalTasq,
  createStatementBinderRegistry,
  exportPortableStore,
  getSignedStatementProof,
  importPortableStore,
  openDb,
  type TrustedStatementBinder,
} from "../src/kernel.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) =>
  rm(root, { recursive: true, force: true }))));
const sha = (value: unknown) =>
  `sha256:${createHash("sha256").update(canonicalizeEffectJson(value as never)).digest("hex")}` as const;

const customDescriptor = StatementBinderDescriptorV1.parse({
  contractVersion: "tasq.statement-binder.v1",
  bindingKind: "custody_handoff",
  purposeUri: "https://schemas.example.test/purposes/custody-handoff/v1",
  purposeVersion: 1,
  subjectTypeUri: "https://schemas.tasq.dev/subjects/artifact/v1",
  allowedProfileUris: [ED25519_STATEMENT_PROFILE_URI],
  nonceMode: "unique",
  maximumAgeMs: 60_000,
  expectedRevisionRequired: false,
  onlineAuthorizationRequired: false,
  binderUri: "https://schemas.example.test/binders/custody-handoff/v1",
  binderVersion: 1,
  binderImplementationDigest: `sha256:${"7".repeat(64)}`,
  recordType: "artifact",
});

const custodyBinder: TrustedStatementBinder = {
  descriptor: customDescriptor,
  async assertTarget({ tx, workspaceId, payload, binding }) {
    const rows = await tx.select().from(artifactTable).where(and(
      eq(artifactTable.tenantId, workspaceId),
      eq(artifactTable.id, binding.recordId),
    )).limit(1);
    if (!rows[0] || payload.subject.id !== binding.recordId ||
      rows[0].digest !== binding.recordDigest) {
      throw new Error("registered custody target does not exist in workspace");
    }
  },
};

describe("TQ-624 trusted statement binder registry", () => {
  test("adds an open-vocabulary binder, fails closed, and restores its portable descriptor", async () => {
    const root = await mkdtemp(join(tmpdir(), "tasq-binder-registry-"));
    roots.push(root);
    const url = `file:${join(root, "db.sqlite")}`;
    const now = 1_900_000_000_000;
    const clock = { now: () => now };
    const local = await createLocalTasq({ url, workspaceId: "team/acme", actor: "author", clock });
    const task = await local.commitments.create({ title: "Transfer exact artifact" });
    await local.close();
    const foreignLocal = await createLocalTasq({
      url,
      workspaceId: "team/other",
      actor: "foreign-author",
      clock,
    });
    const foreignTask = await foreignLocal.commitments.create({ title: "Foreign artifact" });
    await foreignLocal.close();
    const opened = await openDb({ url, wal: false });
    try {
      const digest = `sha256:${"c".repeat(64)}` as const;
      const target = await appendArtifact(opened.db, {
        tenantId: "team/acme",
        taskId: task.id,
        typeUri: customDescriptor.subjectTypeUri,
        name: "parcel.json",
        digest,
        inlineDataRef: "content-addressed:parcel",
      }, { tenantId: "team/acme", actor: "author", clock });
      const foreignDigest = `sha256:${"d".repeat(64)}` as const;
      const foreignTarget = await appendArtifact(opened.db, {
        tenantId: "team/other",
        taskId: foreignTask.id,
        typeUri: customDescriptor.subjectTypeUri,
        name: "foreign-parcel.json",
        digest: foreignDigest,
        inlineDataRef: "content-addressed:foreign-parcel",
      }, { tenantId: "team/other", actor: "foreign-author", clock });
      const { privateKey, publicKey } = generateKeyPairSync("ed25519");
      const publicMaterial = { format: "jwk-okp-ed25519", x: publicKey.export({ format: "jwk" }).x! };
      const credential: SigningCredentialV1 = {
        credentialId: "credential-custody",
        workspaceId: "team/acme",
        principalId: "principal:custodian",
        profileUri: ED25519_STATEMENT_PROFILE_URI,
        profileVersion: 1,
        publicMaterial,
        publicMaterialDigest: sha(publicMaterial),
        trustRootDigest: `sha256:${"a".repeat(64)}`,
        isolationClass: "hardware",
        status: "active",
        revision: 1,
        validFrom: "2026-03-01T00:00:00.000Z",
        enrollmentMethod: "test",
        enrollmentEvidenceDigest: `sha256:${"b".repeat(64)}`,
      };
      const payload: SignedStatementPayloadV1 = {
        contractVersion: "tasq.signed-statement.v1",
        statementId: "statement-custody-1",
        workspaceId: "team/acme",
        audience: "https://server.tasq.example/",
        issuerPrincipalId: credential.principalId,
        credentialId: credential.credentialId,
        purpose: { uri: customDescriptor.purposeUri, version: customDescriptor.purposeVersion },
        subject: { typeUri: customDescriptor.subjectTypeUri, id: target.id, digest },
        nonce: "custody-once",
        issuedAt: new Date(now).toISOString(),
        metadata: {},
      };
      const bundle = await signPurposeBoundStatement(payload, {
        credentialId: credential.credentialId,
        profileUri: ED25519_STATEMENT_PROFILE_URI,
        profileVersion: 1,
        allowedPurposeUris: [customDescriptor.purposeUri],
        signStatement: ({ preAuthenticationEncoding }) => sign(null, preAuthenticationEncoding, privateKey),
      });
      const verify = async (request: {
        bundle: typeof bundle;
        expectedWorkspaceId: string;
        expectedAudience: string;
        acceptanceTime: string;
      }) => ({
        ...await verifyPurposeBoundStatement({
          ...request,
          resolveCredential: () => credential,
        }),
        verifierImplementationDigest: ED25519_VERIFIER_IMPLEMENTATION_DIGEST,
      });
      const binding = {
        bindingKind: customDescriptor.bindingKind,
        recordType: customDescriptor.recordType,
        recordId: target.id,
        recordDigest: digest,
        expectedBinder: {
          uri: customDescriptor.binderUri,
          version: customDescriptor.binderVersion,
          implementationDigest: customDescriptor.binderImplementationDigest,
        },
      } as const;
      const registry = createStatementBinderRegistry([custodyBinder]);

      await expect(acceptSignedStatement(opened.db, {
        bundle,
        expectedAudience: payload.audience,
        binding: { ...binding, bindingKind: "unknown_handoff" },
        binderRegistry: registry,
        verify,
      }, { tenantId: "team/acme", actor: "server", clock })).rejects.toThrow("unknown statement binder");
      await expect(acceptSignedStatement(opened.db, {
        bundle,
        expectedAudience: payload.audience,
        binding: {
          ...binding,
          expectedBinder: { ...binding.expectedBinder, version: 2 },
        },
        binderRegistry: registry,
        verify,
      }, { tenantId: "team/acme", actor: "server", clock })).rejects.toThrow("stale statement binder pin");
      const crossWorkspacePayload = {
        ...payload,
        statementId: "statement-cross-workspace",
        subject: {
          typeUri: customDescriptor.subjectTypeUri,
          id: foreignTarget.id,
          digest: foreignDigest,
        },
        nonce: "cross-workspace-once",
      };
      const crossWorkspaceBundle = await signPurposeBoundStatement(crossWorkspacePayload, {
        credentialId: credential.credentialId,
        profileUri: ED25519_STATEMENT_PROFILE_URI,
        profileVersion: 1,
        allowedPurposeUris: [customDescriptor.purposeUri],
        signStatement: ({ preAuthenticationEncoding }) => sign(null, preAuthenticationEncoding, privateKey),
      });
      await expect(acceptSignedStatement(opened.db, {
        bundle: crossWorkspaceBundle,
        expectedAudience: payload.audience,
        binding: {
          ...binding,
          recordId: foreignTarget.id,
          recordDigest: foreignDigest,
        },
        binderRegistry: registry,
        verify,
      }, { tenantId: "team/acme", actor: "server", clock })).rejects.toThrow("does not exist in workspace");
      expect(() => createStatementBinderRegistry([
        custodyBinder,
        { ...custodyBinder, descriptor: { ...customDescriptor, binderVersion: 2 } },
      ])).toThrow("conflicting statement binder registration");

      const accepted = await acceptSignedStatement(opened.db, {
        bundle,
        expectedAudience: payload.audience,
        binding,
        binderRegistry: registry,
        verify,
      }, { tenantId: "team/acme", actor: "server", clock });
      expect(accepted.binding).toMatchObject({
        bindingKind: "custody_handoff",
        binderDescriptor: customDescriptor,
      });

      const exported = await exportPortableStore(opened.client, "team/acme", { now: now + 1 });
      const importedPath = join(root, "restored.sqlite");
      await importPortableStore(exported.document, importedPath, exported.sha256, now + 2);
      const restored = await openDb({ url: `file:${importedPath}`, wal: false });
      try {
        expect(await getSignedStatementProof(
          restored.db,
          payload.statementId,
          "team/acme",
        )).toMatchObject({
          bindings: [{ bindingKind: "custody_handoff", binderDescriptor: customDescriptor }],
        });
      } finally {
        await restored.close();
      }
    } finally {
      await opened.close();
    }
  });
});
