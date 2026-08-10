import { afterEach, describe, expect, test } from "bun:test";
import { createClient } from "@libsql/client";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgreementTermsV1, SignedStatementPayloadV1 } from "@tasq-run/schema";
import {
  AGREEMENT_ACCEPTANCE_BINDER,
  agreementAcceptanceStatementBinding,
  createLocalTasq,
  createMutableClock,
  exportPortableStore,
  importPortableStore,
  openDb,
} from "../src/kernel.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function store(name: string) {
  const root = await mkdtemp(join(tmpdir(), `tasq-agreement-${name}-`));
  roots.push(root);
  return { root, url: `file:${join(root, "db.sqlite")}` };
}

const digest = (character: string) => `sha256:${character.repeat(64)}` as const;

function terms(input: { buyer: string; worker: string; title?: string; badValidator?: boolean }): AgreementTermsV1 {
  const parties = [
    { principalId: input.buyer, roleUri: "https://schemas.example.test/roles/buyer/v1" },
    { principalId: input.worker, roleUri: "https://schemas.example.test/roles/worker/v1" },
  ].sort((left, right) => left.principalId.localeCompare(right.principalId));
  const policy = (criterion: string, bad = false) => ({
    criteria: [{ id: criterion, statement: `${criterion} is satisfied` }],
    policyKind: "deterministic" as const,
    policyUri: "https://schemas.example.test/policies/exact-evidence/v1",
    policyVersion: 1,
    implementationDigest: digest("a"),
    notBefore: null,
    challengeWindowMs: 0,
    allowSelfValidation: false,
    eligibleValidatorPrincipalIds: bad ? ["missing-validator"] : [],
    adjudicatorPrincipalIds: [],
    metadata: {},
  });
  return {
    contractVersion: "tasq.agreement-terms.v1",
    title: input.title ?? "Exterior verification for fixed consideration",
    purposeUri: "https://schemas.example.test/purposes/field-work/v1",
    parties,
    obligations: [{
      id: "buyer-confirm-payment",
      obligorPrincipalId: input.buyer,
      beneficiaryPrincipalId: input.worker,
      commitment: {
        title: "Confirm payment after accepted evidence",
        description: null,
        successCriteria: "Payment confirmation evidence is accepted",
        notBefore: null,
        dueAt: null,
        priority: null,
        metadata: {},
      },
      resolutionPolicy: policy("payment-confirmed"),
    }, {
      id: "worker-deliver-report",
      obligorPrincipalId: input.worker,
      beneficiaryPrincipalId: input.buyer,
      commitment: {
        title: "Deliver exterior verification report",
        description: null,
        successCriteria: "Fresh report and required images are accepted",
        notBefore: null,
        dueAt: null,
        priority: null,
        metadata: {},
      },
      resolutionPolicy: policy("report-accepted", input.badValidator),
    }],
    terms: { currency: "EUR", amountMinor: 12_500, cancellation: "show_up_fee" },
  };
}

describe("TQ-627 exact multi-party agreements", () => {
  test("binds every party to one digest and atomically compiles reciprocal commitments plus resolution policy", async () => {
    const { url } = await store("accept");
    const clock = createMutableClock(2_500_000_000_000);
    const buyer = await createLocalTasq({ url, workspaceId: "field/acme", actor: "buyer", clock, wal: false });
    const worker = await createLocalTasq({ url, workspaceId: "field/acme", actor: "worker", clock, wal: false });
    try {
      const offer = await buyer.agreements.offer({
        terms: terms({ buyer: buyer.principalId, worker: worker.principalId }),
        expiresAt: clock.now() + 60_000,
      }, { idempotencyKey: "offer" });
      await expect(worker.agreements.accept(offer.id, digest("f"), {
        idempotencyKey: "wrong-digest",
      })).rejects.toThrow("does not match exact offer");
      const partial = await buyer.agreements.accept(offer.id, offer.termsDigest, {
        idempotencyKey: "buyer-accepts",
      });
      expect(partial).toMatchObject({ state: "offered", activation: null });
      expect(await buyer.commitments.list()).toEqual([]);

      // Assignment acceptance is responsibility only; it does not add an agreement acceptance.
      const unrelated = await buyer.commitments.create({ title: "Unrelated work" }, { idempotencyKey: "unrelated" });
      const assignment = await buyer.assignments.propose({
        taskId: unrelated.id, assigneePrincipalId: worker.principalId, role: "owner",
      }, { idempotencyKey: "assignment" });
      await worker.assignments.accept(assignment.id, { expectedRevision: 1 });
      expect((await buyer.agreements.get(offer.id))?.acceptances).toHaveLength(1);

      const accepted = await worker.agreements.accept(offer.id, offer.termsDigest, {
        idempotencyKey: "worker-accepts",
      });
      expect(accepted).toMatchObject({
        state: "accepted",
        assurance: { assignmentAcceptanceIsAgreement: false, effectAuthorityGranted: false },
      });
      expect(accepted.acceptances.map(({ termsDigest }) => termsDigest)).toEqual([
        offer.termsDigest, offer.termsDigest,
      ]);
      expect(accepted.activation?.compilations).toHaveLength(2);
      const commitments = (await buyer.commitments.list()).filter(({ id }) => id !== unrelated.id);
      expect(commitments).toHaveLength(2);
      expect(commitments.every(({ completionPolicy, validationRequired }) =>
        completionPolicy === "evidence" && validationRequired)).toBe(true);
      expect(JSON.stringify(commitments)).not.toContain("amountMinor");
      for (const compilation of accepted.activation!.compilations) {
        expect((await buyer.resolution.contracts.get(compilation.resolutionContractId))?.taskId)
          .toBe(compilation.commitmentId);
      }

      const workerAcceptance = accepted.acceptances.find(({ partyPrincipalId }) => partyPrincipalId === worker.principalId)!;
      const opened = await openDb({ url, wal: false });
      try {
        const payload: SignedStatementPayloadV1 = {
          contractVersion: "tasq.signed-statement.v1",
          statementId: "agreement-acceptance-statement",
          workspaceId: "field/acme",
          audience: "https://server.tasq.example/",
          issuerPrincipalId: worker.principalId,
          credentialId: "worker-key",
          purpose: { uri: AGREEMENT_ACCEPTANCE_BINDER.descriptor.purposeUri, version: 1 },
          subject: {
            typeUri: AGREEMENT_ACCEPTANCE_BINDER.descriptor.subjectTypeUri,
            id: workerAcceptance.id,
            digest: workerAcceptance.acceptanceDigest,
          },
          nonce: "agreement-acceptance-once",
          issuedAt: new Date(clock.now()).toISOString(),
          metadata: {},
        };
        const binding = agreementAcceptanceStatementBinding(workerAcceptance);
        await AGREEMENT_ACCEPTANCE_BINDER.assertTarget({ tx: opened.db, workspaceId: "field/acme", payload, binding });
        await expect(AGREEMENT_ACCEPTANCE_BINDER.assertTarget({
          tx: opened.db, workspaceId: "field/acme",
          payload: { ...payload, issuerPrincipalId: buyer.principalId }, binding,
        })).rejects.toThrow("signer is not the accepting party");
      } finally {
        await opened.close();
      }

      const raw = createClient({ url });
      await expect(raw.execute("UPDATE agreement_offer SET terms_digest = 'forged'"))
        .rejects.toThrow("agreement offers are immutable");
      await expect(raw.execute("DELETE FROM agreement_acceptance"))
        .rejects.toThrow("agreement acceptances are append-only");
      raw.close();
    } finally {
      await worker.close();
      await buyer.close();
    }
  });

  test("rolls the final acceptance and every compiled row back on a late policy failure", async () => {
    const { url } = await store("rollback");
    const clock = createMutableClock(2_600_000_000_000);
    const buyer = await createLocalTasq({ url, workspaceId: "field/rollback", actor: "buyer", clock, wal: false });
    const worker = await createLocalTasq({ url, workspaceId: "field/rollback", actor: "worker", clock, wal: false });
    try {
      const offer = await buyer.agreements.offer({
        terms: terms({ buyer: buyer.principalId, worker: worker.principalId, badValidator: true }),
        expiresAt: clock.now() + 60_000,
      });
      await buyer.agreements.accept(offer.id, offer.termsDigest);
      await expect(worker.agreements.accept(offer.id, offer.termsDigest))
        .rejects.toThrow("Principal not found");
      const view = await buyer.agreements.get(offer.id);
      expect(view).toMatchObject({ state: "offered", activation: null });
      expect(view?.acceptances).toHaveLength(1);
      expect(await buyer.commitments.list()).toEqual([]);
    } finally {
      await worker.close();
      await buyer.close();
    }
  });

  test("preserves withdrawal, rejection, expiry, and accepted amendment history", async () => {
    const { url } = await store("history");
    const clock = createMutableClock(2_700_000_000_000);
    const buyer = await createLocalTasq({ url, workspaceId: "field/history", actor: "buyer", clock, wal: false });
    const worker = await createLocalTasq({ url, workspaceId: "field/history", actor: "worker", clock, wal: false });
    try {
      const withdrawn = await buyer.agreements.offer({
        terms: terms({ buyer: buyer.principalId, worker: worker.principalId, title: "Withdraw me" }),
        expiresAt: clock.now() + 10_000,
      });
      expect((await buyer.agreements.withdraw(withdrawn.id, {
        termsDigest: withdrawn.termsDigest, reason: "scope changed",
      })).state).toBe("withdrawn");

      const rejected = await buyer.agreements.offer({
        terms: terms({ buyer: buyer.principalId, worker: worker.principalId, title: "Reject me" }),
        expiresAt: clock.now() + 10_000,
      });
      expect((await worker.agreements.reject(rejected.id, {
        termsDigest: rejected.termsDigest, reason: "not available",
      })).state).toBe("rejected");

      const expired = await buyer.agreements.offer({
        terms: terms({ buyer: buyer.principalId, worker: worker.principalId, title: "Expire me" }),
        expiresAt: clock.now() + 10,
      });
      clock.advance(10);
      expect((await buyer.agreements.get(expired.id))?.state).toBe("expired");

      const original = await buyer.agreements.offer({
        terms: terms({ buyer: buyer.principalId, worker: worker.principalId, title: "Original" }),
        expiresAt: clock.now() + 10_000,
      });
      await buyer.agreements.accept(original.id, original.termsDigest);
      const originalAccepted = await worker.agreements.accept(original.id, original.termsDigest);
      const oldCommitments = originalAccepted.activation!.compilations.map(({ commitmentId }) => commitmentId);

      const amendment = await buyer.agreements.offer({
        terms: terms({ buyer: buyer.principalId, worker: worker.principalId, title: "Amended" }),
        expiresAt: clock.now() + 10_000,
        supersedesOfferId: original.id,
      });
      await buyer.agreements.accept(amendment.id, amendment.termsDigest);
      const amended = await worker.agreements.accept(amendment.id, amendment.termsDigest);
      expect(amended.activation?.supersedesActivationId).toBe(originalAccepted.activation?.id);
      expect((await buyer.agreements.get(original.id))?.state).toBe("superseded");
      for (const id of oldCommitments) expect((await buyer.commitments.get(id))?.status).toBe("cancelled");
      expect((await buyer.agreements.list()).map(({ id }) => id).sort()).toEqual([
        withdrawn.id, rejected.id, expired.id, original.id, amendment.id,
      ].sort());
    } finally {
      await worker.close();
      await buyer.close();
    }
  });

  test("round-trips exact offer, acceptance, and activation ledgers through portable export", async () => {
    const source = await store("portable-source");
    const target = await store("portable-target");
    const clock = createMutableClock(2_800_000_000_000);
    const buyer = await createLocalTasq({ url: source.url, workspaceId: "field/portable", actor: "buyer", clock, wal: false });
    const worker = await createLocalTasq({ url: source.url, workspaceId: "field/portable", actor: "worker", clock, wal: false });
    try {
      const offer = await buyer.agreements.offer({
        terms: terms({ buyer: buyer.principalId, worker: worker.principalId }),
        expiresAt: clock.now() + 10_000,
      });
      await buyer.agreements.accept(offer.id, offer.termsDigest);
      const accepted = await worker.agreements.accept(offer.id, offer.termsDigest);
      const opened = await openDb({ url: source.url, wal: false });
      const exported = await exportPortableStore(opened.client, "field/portable", { now: clock.now() });
      await opened.close();
      const targetPath = join(target.root, "restored.sqlite");
      await importPortableStore(exported.document, targetPath, exported.sha256, clock.now());
      const restored = await createLocalTasq({
        url: `file:${targetPath}`, workspaceId: "field/portable", actor: "buyer", clock, wal: false,
      });
      try {
        expect(await restored.agreements.get(offer.id)).toEqual(accepted);
      } finally {
        await restored.close();
      }
    } finally {
      await worker.close();
      await buyer.close();
    }
  });
});
