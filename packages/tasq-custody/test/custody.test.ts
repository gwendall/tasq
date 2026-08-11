import { afterEach, describe, expect, test } from "bun:test";
import { createClient } from "@libsql/client";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMutableClock, prepareTargetRefV1, type TargetRefV1 } from "@tasq-run/schema";
import {
  CUSTODY_DESIGN_DECISION,
  ExperimentalCustodyStore,
  custodyDigest,
  type CustodyPortableV1,
} from "../src/index.js";

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function target(resourceType: string, value: string, version: string | null = null): TargetRefV1 {
  return {
    contractVersion: "tasq.target-ref.v1",
    namespace: "https://logistics.example.test/targets/",
    resourceType,
    identifier: { form: "plain", value },
    version,
    digest: null,
  };
}

async function stores(name: string, count = 1) {
  const root = mkdtempSync(join(tmpdir(), `tasq-custody-${name}-`));
  roots.push(root);
  const path = join(root, "custody.sqlite");
  const clock = createMutableClock(1_000);
  const opened: ExperimentalCustodyStore[] = [];
  for (let index = 0; index < count; index += 1) {
    opened.push(await ExperimentalCustodyStore.open({ url: `file:${path}`, clock, busyTimeoutMs: 250 }));
  }
  return { root, path, clock, stores: opened };
}

function ctx(workspaceId: string, actorPrincipalId: string, idempotencyKey: string) {
  return { workspaceId, actorPrincipalId, idempotencyKey };
}

async function establish(store: ExperimentalCustodyStore, workspaceId: string, actor: string, ref: TargetRefV1) {
  return store.establish({
    target: ref,
    custodianPrincipalId: actor,
    condition: { state: "sealed", observedBy: actor },
    evidenceRefs: [`evidence:${actor}:initial`],
    effectiveAt: 900,
  }, ctx(workspaceId, actor, `establish:${actor}`));
}

async function offerAndAccept(input: {
  store: ExperimentalCustodyStore;
  workspaceId: string;
  sourceStateId: string;
  targetDigest: string;
  from: string;
  to: string;
  key: string;
  condition?: Record<string, unknown>;
}) {
  const condition = input.condition ?? { state: "sealed" };
  const handoff = await input.store.offer({
    targetDigest: input.targetDigest,
    sourceStateId: input.sourceStateId,
    toPrincipalId: input.to,
    condition,
    evidenceRequirements: ["recipient_signature", "seal_photo"],
    expiresAt: 5_000,
  }, ctx(input.workspaceId, input.from, `offer:${input.key}`));
  return input.store.accept(handoff.id, {
    expectedRevision: 1,
    conditionDigest: handoff.conditionDigest,
    acceptanceEvidence: [
      { requirement: "seal_photo", evidenceRef: `evidence:${input.key}:photo` },
      { requirement: "recipient_signature", evidenceRef: `evidence:${input.key}:signature` },
    ],
    effectiveAt: 1_000,
  }, ctx(input.workspaceId, input.to, `accept:${input.key}`));
}

describe("experimental custody lifecycle", () => {
  test("preserves parcel handoffs, refusal and incident lineage without claiming physical truth", async () => {
    const { stores: [store] } = await stores("parcel");
    const workspaceId = "custody/parcel";
    const initial = await establish(store!, workspaceId, "seller", target("parcel", "parcel:42", "label-v1"));
    const courier = await offerAndAccept({
      store: store!, workspaceId, sourceStateId: initial.id, targetDigest: initial.targetDigest,
      from: "seller", to: "courier", key: "seller-courier",
    });
    const refused = await store!.offer({
      targetDigest: initial.targetDigest,
      sourceStateId: courier.state.id,
      toPrincipalId: "wrong-warehouse",
      condition: { state: "sealed" },
      evidenceRequirements: ["dock_receipt"],
      expiresAt: 5_000,
    }, ctx(workspaceId, "courier", "offer:wrong-warehouse"));
    const refusal = await store!.refuse(refused.id, { expectedRevision: 1, reason: "Wrong destination" },
      ctx(workspaceId, "wrong-warehouse", "refuse:wrong-warehouse"));
    expect(refusal.status).toBe("refused");
    const warehouse = await offerAndAccept({
      store: store!, workspaceId, sourceStateId: courier.state.id, targetDigest: initial.targetDigest,
      from: "courier", to: "warehouse", key: "courier-warehouse", condition: { state: "corner_dented" },
    });
    const incident = await store!.reportIncident({
      targetDigest: initial.targetDigest,
      stateId: warehouse.state.id,
      kindUri: "https://tasq.run/incidents/damage/v1",
      summary: "Corner damage observed after warehouse acceptance.",
      evidenceRefs: ["evidence:warehouse:damage-photo"],
      occurredAt: 1_000,
    }, ctx(workspaceId, "warehouse", "incident:damage"));
    const recipient = await offerAndAccept({
      store: store!, workspaceId, sourceStateId: warehouse.state.id, targetDigest: initial.targetDigest,
      from: "warehouse", to: "recipient", key: "warehouse-recipient", condition: { state: "corner_dented" },
    });

    const current = await store!.current(workspaceId, initial.targetDigest, 1_100);
    expect(current?.currentState.id).toBe(recipient.state.id);
    expect(current?.currentState.custodianPrincipalId).toBe("recipient");
    expect(current?.incidents).toEqual([incident]);
    expect(current?.assurance).toEqual({
      recordedLineageIsPhysicalTruth: false,
      grantsOwnershipOrEffectAuthority: false,
    });
    store!.close();
  });

  test("elects exactly one successor when two recipients race from one equipment state", async () => {
    const { stores: [writer, recipientA, recipientB] } = await stores("equipment-race", 3);
    const workspaceId = "custody/equipment";
    const initial = await establish(writer!, workspaceId, "technician", target("equipment", "rack:pdu-7", "serial-991"));
    const makeOffer = (to: string) => writer!.offer({
      targetDigest: initial.targetDigest,
      sourceStateId: initial.id,
      toPrincipalId: to,
      condition: { state: "powered_off", serial: "991" },
      evidenceRequirements: ["serial_scan"],
      expiresAt: 5_000,
    }, ctx(workspaceId, "technician", `offer:${to}`));
    const [offerA, offerB] = await Promise.all([makeOffer("operator-a"), makeOffer("operator-b")]);
    const accept = (store: ExperimentalCustodyStore, offer: typeof offerA, actor: string) => store.accept(offer.id, {
      expectedRevision: 1,
      conditionDigest: offer.conditionDigest,
      acceptanceEvidence: [{ requirement: "serial_scan", evidenceRef: `evidence:${actor}:scan` }],
      effectiveAt: 1_000,
    }, ctx(workspaceId, actor, `accept:${actor}`));
    const results = await Promise.allSettled([
      accept(recipientA!, offerA, "operator-a"),
      accept(recipientB!, offerB, "operator-b"),
    ]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
    const current = await writer!.current(workspaceId, initial.targetDigest);
    expect(current).not.toBeNull();
    expect(current!.states).toHaveLength(2);
    expect(["operator-a", "operator-b"]).toContain(current!.currentState.custodianPrincipalId);
    for (const store of [writer!, recipientA!, recipientB!]) store.close();
  });

  test("binds cryptographic-control identity and condition evidence but grants no key or action authority", async () => {
    const { stores: [store], clock } = await stores("crypto-control");
    const workspaceId = "custody/crypto-control";
    const ref = target("cryptographic_control", "kms-key:billing-signing", "version-3");
    const initial = await establish(store!, workspaceId, "security-admin", ref);
    const handoff = await store!.offer({
      targetDigest: initial.targetDigest,
      sourceStateId: initial.id,
      toPrincipalId: "release-operator",
      condition: { keyMaterialExported: false, quorumPolicy: "two-person-v2" },
      evidenceRequirements: ["kms_policy_digest", "operator_ack"],
      expiresAt: 2_000,
    }, ctx(workspaceId, "security-admin", "offer:control"));
    await expect(store!.accept(handoff.id, {
      expectedRevision: 1,
      conditionDigest: custodyDigest("tasq.custody-condition.v1", { keyMaterialExported: false, quorumPolicy: "drifted" }),
      acceptanceEvidence: [
        { requirement: "kms_policy_digest", evidenceRef: "evidence:kms-policy" },
        { requirement: "operator_ack", evidenceRef: "evidence:operator-ack" },
      ], effectiveAt: 1_000,
    }, ctx(workspaceId, "release-operator", "accept:drift"))).rejects.toThrow("condition digest drift");
    const accepted = await store!.accept(handoff.id, {
      expectedRevision: 1,
      conditionDigest: handoff.conditionDigest,
      acceptanceEvidence: [
        { requirement: "kms_policy_digest", evidenceRef: "evidence:kms-policy" },
        { requirement: "operator_ack", evidenceRef: "evidence:operator-ack" },
      ], effectiveAt: 1_000,
    }, ctx(workspaceId, "release-operator", "accept:control"));
    expect(accepted.state.targetDigest).toBe(prepareTargetRefV1(ref).targetDigest);
    const current = await store!.current(workspaceId, initial.targetDigest);
    expect(JSON.stringify(current)).not.toContain("privateKey");
    expect(current?.assurance.grantsOwnershipOrEffectAuthority).toBeFalse();

    const expiring = await store!.offer({
      targetDigest: initial.targetDigest, sourceStateId: accepted.state.id, toPrincipalId: "backup-operator",
      condition: { keyMaterialExported: false }, evidenceRequirements: ["operator_ack"], expiresAt: 2_000,
    }, ctx(workspaceId, "release-operator", "offer:expiry"));
    clock.set(2_000);
    await expect(store!.accept(expiring.id, {
      expectedRevision: 1, conditionDigest: expiring.conditionDigest,
      acceptanceEvidence: [{ requirement: "operator_ack", evidenceRef: "evidence:late" }], effectiveAt: 2_000,
    }, ctx(workspaceId, "backup-operator", "accept:expiry"))).rejects.toThrow("expired");
    store!.close();
  });

  test("replays lost responses exactly and makes authoritative rows append-only", async () => {
    const { stores: [store], path } = await stores("retry-immutable");
    const workspaceId = "custody/retry";
    const input = {
      target: target("parcel", "parcel:retry"), custodianPrincipalId: "seller",
      condition: { state: "sealed" }, evidenceRefs: ["evidence:initial"], effectiveAt: 900,
    };
    const first = await store!.establish(input, ctx(workspaceId, "seller", "lost-response"));
    const replay = await store!.establish(input, ctx(workspaceId, "seller", "lost-response"));
    expect(replay).toEqual(first);
    await expect(store!.establish({ ...input, condition: { state: "open" } },
      ctx(workspaceId, "seller", "lost-response"))).rejects.toThrow("idempotency key reused");

    const raw = createClient({ url: `file:${path}` });
    await expect(raw.execute({
      sql: "UPDATE experimental_custody_state SET custodian_principal_id = ? WHERE id = ?",
      args: ["attacker", first.id],
    })).rejects.toThrow("immutable");
    raw.close();
    store!.close();
  });

  test("exports and imports one exact portable lineage and rejects a hostile packet before mutation", async () => {
    const source = await stores("portable-source");
    const workspaceId = "custody/portable";
    const initial = await establish(source.stores[0]!, workspaceId, "seller", target("parcel", "parcel:portable"));
    await offerAndAccept({
      store: source.stores[0]!, workspaceId, sourceStateId: initial.id, targetDigest: initial.targetDigest,
      from: "seller", to: "recipient", key: "portable",
    });
    const packet = await source.stores[0]!.exportPortable(workspaceId, 1_500);

    const destination = await stores("portable-destination");
    await destination.stores[0]!.importPortable(packet);
    expect(await destination.stores[0]!.exportPortable(workspaceId, 1_500)).toEqual(packet);

    const hostileDestination = await stores("portable-hostile");
    const hostile = structuredClone(packet) as CustodyPortableV1;
    hostile.states = hostile.states.filter(({ predecessorStateId }) => predecessorStateId === null);
    const { exportDigest: _ignored, ...hostileBody } = hostile;
    hostile.exportDigest = custodyDigest("tasq.custody-portable.v1", hostileBody);
    await expect(hostileDestination.stores[0]!.importPortable(hostile)).rejects.toThrow("status disagrees");
    const empty = await hostileDestination.stores[0]!.exportPortable(workspaceId, 1_500);
    expect(empty.targets).toHaveLength(0);
    expect(empty.states).toHaveLength(0);
    source.stores[0]!.close();
    destination.stores[0]!.close();
    hostileDestination.stores[0]!.close();
  });

  test("records the first-principles graduation decision without Kernel admission", () => {
    expect(CUSTODY_DESIGN_DECISION.alternatives.resourceLease.decision).toBe("reject_as_custody_model");
    expect(CUSTODY_DESIGN_DECISION.alternatives.signedObservation.decision).toBe("compose_as_evidence_only");
    expect(CUSTODY_DESIGN_DECISION.alternatives.firstClassHandoff.decision).toBe("graduate_as_shared_experimental_module");
    expect(CUSTODY_DESIGN_DECISION.kernelAdmission.decision).toBe("not_requested");
    expect(CUSTODY_DESIGN_DECISION.assurance).toEqual({
      provesPhysicalPossession: false,
      grantsOwnership: false,
      grantsEffectAuthority: false,
    });
  });
});
