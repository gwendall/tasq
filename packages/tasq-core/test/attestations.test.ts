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
import {
  canonicalizeEffectJson,
  type SignedStatementPayloadV1,
  type SigningCredentialV1,
  type AttestationIssueInputV1,
} from "@tasq-run/schema";
import {
  ATTESTATION_ISSUANCE_BINDER,
  ATTESTATION_ISSUANCE_BINDER_DESCRIPTOR,
  acceptSignedStatement,
  attestationStatementBinding,
  createLocalTasq,
  createMutableClock,
  createStatementBinderRegistry,
  exportPortableStore,
  getAttestation,
  importPortableStore,
  openDb,
} from "../src/kernel.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) =>
  rm(root, { recursive: true, force: true }))));
const sha = (value: unknown) =>
  `sha256:${createHash("sha256").update(canonicalizeEffectJson(value as never)).digest("hex")}` as const;

describe("TQ-625 provider-neutral attestations", () => {
  test("evaluates exact current claims across expiry, supersession, revocation, and workspace boundaries", async () => {
    const root = await mkdtemp(join(tmpdir(), "tasq-attestations-"));
    roots.push(root);
    const url = `file:${join(root, "db.sqlite")}`;
    const clock = createMutableClock(2_100_000_000_000);
    const issuer = await createLocalTasq({
      url, workspaceId: "operations/acme", actor: "issuer:acme", clock, wal: false,
    });
    const subject = {
      typeUri: "https://schemas.example.test/subjects/technician/v1",
      id: "technician:42",
      digest: null,
    };
    const siteScope = [{
      typeUri: "https://schemas.example.test/scopes/site/v1",
      value: "dc:paris-1",
      digest: null,
    }];
    const licencePurpose = {
      uri: "https://schemas.example.test/purposes/electrical-licence/v1",
      version: 1,
    };
    const accessPurpose = {
      uri: "https://schemas.example.test/purposes/site-access/v1",
      version: 1,
    };
    try {
      const licenceInput: AttestationIssueInputV1 = {
        subject,
        purpose: licencePurpose,
        scope: [...siteScope],
        claim: {
          typeUri: "https://schemas.example.test/claims/licence-class/v1",
          version: 1,
          value: { class: "low-voltage", jurisdiction: "FR" },
        },
        evidence: [{
          typeUri: "https://schemas.example.test/evidence/licence-registry/v1",
          digest: `sha256:${"1".repeat(64)}`,
          uri: "https://registry.example.test/licences/42",
        }],
        expiresAt: clock.now() + 100_000,
      };
      const licence = await issuer.attestations.issue(
        licenceInput,
        { idempotencyKey: "licence-42" },
      );
      clock.advance(1);
      expect(await issuer.attestations.issue(
        licenceInput,
        { idempotencyKey: "licence-42" },
      )).toEqual(licence);
      const access = await issuer.attestations.issue({
        subject,
        purpose: accessPurpose,
        scope: [...siteScope],
        claim: {
          typeUri: "https://schemas.example.test/claims/access-level/v1",
          version: 1,
          value: { level: "escorted" },
        },
      });
      const requirements = [
        {
          purpose: licencePurpose,
          claimTypeUri: licence.claim.typeUri,
          claimVersion: 1,
          acceptedIssuerPrincipalIds: [issuer.principalId],
          requiredScope: [...siteScope],
          claimDigest: licence.claimDigest,
        },
        {
          purpose: accessPurpose,
          claimTypeUri: access.claim.typeUri,
          claimVersion: 1,
          acceptedIssuerPrincipalIds: [issuer.principalId],
          requiredScope: [...siteScope],
          claimDigest: null,
        },
      ];
      expect(await issuer.attestations.evaluate({ subject, requirements, at: clock.now() })).toMatchObject({
        outcome: "eligible",
        basisAttestationIds: expect.arrayContaining([licence.id, access.id]),
        assurance: { claimTruth: "not_asserted", authority: "not_granted" },
      });
      expect(await issuer.attestations.evaluate({
        subject,
        at: clock.now(),
        requirements: [{ ...requirements[0]!, purpose: { ...licencePurpose, version: 2 } }],
      })).toMatchObject({ outcome: "ineligible", unsatisfiedRequirementIndexes: [0] });

      clock.advance(1_000);
      const successor = await issuer.attestations.issue({
        subject,
        purpose: licencePurpose,
        scope: [...siteScope],
        claim: {
          ...licence.claim,
          value: { class: "high-voltage", jurisdiction: "FR" },
        },
        supersedesAttestationId: licence.id,
        expiresAt: clock.now() + 200_000,
      });
      expect((await issuer.attestations.current({
        subject, purpose: licencePurpose, at: licence.notBefore,
      })).map(({ id }) => id)).toEqual([licence.id]);
      expect((await issuer.attestations.current({
        subject, purpose: licencePurpose, at: clock.now(),
      })).map(({ id }) => id)).toEqual([successor.id]);

      const other = await createLocalTasq({
        url, workspaceId: "operations/acme", actor: "issuer:other", clock, wal: false,
      });
      try {
        await expect(other.attestations.revoke(successor.id, {
          reasonCode: "issuer_request",
        })).rejects.toThrow("only the authenticated attestation issuer");
      } finally {
        await other.close();
      }
      clock.advance(1_000);
      const revocation = await issuer.attestations.revoke(successor.id, {
        reasonCode: "licence_suspended",
        explanation: "Registry reported a suspension",
      }, { idempotencyKey: "revoke-successor" });
      clock.advance(1);
      expect(await issuer.attestations.revoke(successor.id, {
        reasonCode: "licence_suspended",
        explanation: "Registry reported a suspension",
      }, { idempotencyKey: "revoke-successor" })).toEqual(revocation);
      expect(await issuer.attestations.current({
        subject, purpose: licencePurpose, at: clock.now(),
      })).toEqual([]);
      expect(await issuer.attestations.current({
        subject, purpose: licencePurpose, at: successor.notBefore,
      })).toEqual([successor]);

      const foreign = await createLocalTasq({
        url, workspaceId: "operations/other", actor: "reader:other", clock, wal: false,
      });
      try {
        expect(await foreign.attestations.get(licence.id)).toBeNull();
        expect(await foreign.attestations.current({ subject, at: clock.now() })).toEqual([]);
      } finally {
        await foreign.close();
      }

      const opened = await openDb({ url, wal: false });
      try {
        await expect(opened.client.execute({
          sql: "UPDATE attestation SET claim_json = '{}' WHERE id = ?",
          args: [licence.id],
        })).rejects.toThrow("attestations are immutable");
        await expect(opened.client.execute({
          sql: "DELETE FROM attestation_revocation WHERE id = ?",
          args: [revocation.id],
        })).rejects.toThrow("attestation revocations are append-only");
        const exported = await exportPortableStore(opened.client, "operations/acme", { now: clock.now() });
        expect(exported.document.tables.find(({ name }) => name === "attestation")?.rows).toHaveLength(3);
        expect(exported.document.tables.find(({ name }) => name === "attestation_revocation")?.rows).toHaveLength(1);
        const restoredPath = join(root, "restored.sqlite");
        await importPortableStore(exported.document, restoredPath, exported.sha256, clock.now());
        const restored = await openDb({ url: `file:${restoredPath}`, wal: false });
        try {
          expect(await getAttestation(restored.db, successor.id, "operations/acme"))
            .toMatchObject({ id: successor.id, attestationDigest: successor.attestationDigest });
        } finally {
          await restored.close();
        }
      } finally {
        await opened.close();
      }
    } finally {
      await issuer.close();
    }
  });

  test("binds a signed issuer to exact attestation bytes without asserting truth or authority", async () => {
    const root = await mkdtemp(join(tmpdir(), "tasq-attestation-signature-"));
    roots.push(root);
    const url = `file:${join(root, "db.sqlite")}`;
    const clock = createMutableClock(2_200_000_000_000);
    const local = await createLocalTasq({
      url, workspaceId: "software/acme", actor: "issuer:builder", clock, wal: false,
    });
    try {
      const record = await local.attestations.issue({
        subject: {
          typeUri: "https://schemas.example.test/subjects/software-artifact/v1",
          id: "oci:sha256:abc",
          digest: `sha256:${"a".repeat(64)}`,
        },
        purpose: {
          uri: "https://schemas.example.test/purposes/software-provenance/v1",
          version: 1,
        },
        claim: {
          typeUri: "https://schemas.example.test/claims/build-provenance/v1",
          version: 1,
          value: { builder: "release-workflow", sourceRevision: "abc123" },
        },
      });
      const opened = await openDb({ url, wal: false });
      try {
        const { privateKey, publicKey } = generateKeyPairSync("ed25519");
        const publicMaterial = { format: "jwk-okp-ed25519", x: publicKey.export({ format: "jwk" }).x! };
        const credential: SigningCredentialV1 = {
          credentialId: "credential-builder",
          workspaceId: "software/acme",
          principalId: local.principalId,
          profileUri: ED25519_STATEMENT_PROFILE_URI,
          profileVersion: 1,
          publicMaterial,
          publicMaterialDigest: sha(publicMaterial),
          trustRootDigest: `sha256:${"b".repeat(64)}`,
          isolationClass: "isolated_process",
          status: "active",
          revision: 1,
          validFrom: new Date(clock.now() - 1_000).toISOString(),
          enrollmentMethod: "test",
          enrollmentEvidenceDigest: `sha256:${"c".repeat(64)}`,
        };
        const payload: SignedStatementPayloadV1 = {
          contractVersion: "tasq.signed-statement.v1",
          statementId: "statement-attestation-1",
          workspaceId: "software/acme",
          audience: "https://server.tasq.example/",
          issuerPrincipalId: local.principalId,
          credentialId: credential.credentialId,
          purpose: {
            uri: ATTESTATION_ISSUANCE_BINDER_DESCRIPTOR.purposeUri,
            version: ATTESTATION_ISSUANCE_BINDER_DESCRIPTOR.purposeVersion,
          },
          subject: {
            typeUri: ATTESTATION_ISSUANCE_BINDER_DESCRIPTOR.subjectTypeUri,
            id: record.id,
            digest: record.attestationDigest,
          },
          nonce: "attestation-once",
          issuedAt: new Date(clock.now()).toISOString(),
          metadata: {},
        };
        const bundle = await signPurposeBoundStatement(payload, {
          credentialId: credential.credentialId,
          profileUri: ED25519_STATEMENT_PROFILE_URI,
          profileVersion: 1,
          allowedPurposeUris: [ATTESTATION_ISSUANCE_BINDER_DESCRIPTOR.purposeUri],
          signStatement: ({ preAuthenticationEncoding }) => sign(null, preAuthenticationEncoding, privateKey),
        });
        const accepted = await acceptSignedStatement(opened.db, {
          bundle,
          expectedAudience: payload.audience,
          binding: attestationStatementBinding(record),
          binderRegistry: createStatementBinderRegistry([ATTESTATION_ISSUANCE_BINDER]),
          verify: async (request) => ({
            ...await verifyPurposeBoundStatement({
              ...request,
              resolveCredential: () => credential,
            }),
            verifierImplementationDigest: ED25519_VERIFIER_IMPLEMENTATION_DIGEST,
          }),
        }, { tenantId: "software/acme", principalId: local.principalId, clock });
        expect(accepted.binding).toMatchObject({
          bindingKind: "attestation_issuance",
          recordId: record.id,
          recordDigest: record.attestationDigest,
        });
        // A REAL statement, signed the same way, whose binding names a digest
        // it does not carry. The previous version of this put a payload OBJECT
        // where the bundle holds base64url, so it proved that garbage is
        // refused - not that a mismatched binding is.
        const wrongBundle = await signPurposeBoundStatement(
          { ...payload, statementId: "statement-attestation-wrong", nonce: "attestation-twice" },
          {
            credentialId: credential.credentialId,
            profileUri: ED25519_STATEMENT_PROFILE_URI,
            profileVersion: 1,
            allowedPurposeUris: [ATTESTATION_ISSUANCE_BINDER_DESCRIPTOR.purposeUri],
            signStatement: ({ preAuthenticationEncoding }) => sign(null, preAuthenticationEncoding, privateKey),
          },
        );
        await expect(acceptSignedStatement(opened.db, {
          bundle: wrongBundle,
          expectedAudience: payload.audience,
          binding: { ...attestationStatementBinding(record), recordDigest: `sha256:${"f".repeat(64)}` },
          binderRegistry: createStatementBinderRegistry([ATTESTATION_ISSUANCE_BINDER]),
          verify: async (request) => ({
            ...await verifyPurposeBoundStatement({ ...request, resolveCredential: () => credential }),
            verifierImplementationDigest: ED25519_VERIFIER_IMPLEMENTATION_DIGEST,
          }),
        }, { tenantId: "software/acme", principalId: local.principalId, clock })).rejects.toThrow();
      } finally {
        await opened.close();
      }
    } finally {
      await local.close();
    }
  });
});
