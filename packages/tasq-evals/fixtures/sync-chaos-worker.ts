/**
 * One-shot process boundary for TQ-406.
 *
 * The parent supplies every semantic timestamp. After the selected durable
 * operation commits, this worker emits one boundary receipt and deliberately
 * stays alive so the parent can SIGKILL it without running cleanup handlers.
 */

import { readFileSync, writeFileSync } from "node:fs";
import {
  acceptReplicationPush,
  acknowledgeReplicationPush,
  completeDelivery,
  createCommitment,
  createMutableClock,
  getReplicationAuthority,
  installReplicationSnapshotAndRebase,
  leaseNextDelivery,
  openDb,
  queueReplicatedCommitmentCreate,
  recoverReplicationAuthority,
} from "@tasq/core";

type Base = { dbPath: string; now: number };
type Config = Base & ({
  action: "queue_create";
  workspaceId: string;
  actor: string;
  commitmentId: string;
  title: string;
} | {
  action: "accept_push";
  requestPath: string;
  authenticatedReplicaId: string;
  authenticatedPrincipalId: string;
  actor: string;
} | {
  action: "ack_push";
  responsePath: string;
} | {
  action: "install_snapshot";
  snapshotPath: string;
  actor: string;
  cursor?: string;
} | {
  action: "recover_authority";
  workspaceId: string;
  expectedAuthorityReplicaId: string;
  expectedAuthorityEpoch: string;
  expectedCurrentSequence: number;
  newAuthorityEpoch: string;
  reason: string;
} | {
  action: "create_commitment";
  workspaceId: string;
  actor: string;
  title: string;
} | {
  action: "lease_delivery";
  tenantId: string;
  sinkId: string;
  leaseOwner: string;
  leaseMs: number;
} | {
  action: "apply_external_effect";
  receiptPath: string;
  eventId: string;
  eventSequence: number;
} | {
  action: "complete_delivery";
  tenantId: string;
  deliveryId: string;
  leaseOwner: string;
});

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

const configPath = process.env.TASQ_SYNC_CHAOS_CONFIG;
if (!configPath) throw new Error("TASQ_SYNC_CHAOS_CONFIG is required");
const config = readJson(configPath) as Config;
if (!Number.isSafeInteger(config.now) || config.now < 0) {
  throw new Error("The injected worker clock must be a non-negative unix-ms integer");
}

const clock = createMutableClock(config.now);
const store = await openDb({ url: `file:${config.dbPath}`, wal: true });
let receipt: Record<string, unknown>;

switch (config.action) {
  case "queue_create": {
    const queued = await queueReplicatedCommitmentCreate(store.db, {
      id: config.commitmentId,
      title: config.title,
    }, { workspaceId: config.workspaceId, actor: config.actor, clock });
    receipt = {
      boundary: "local_operation_committed",
      operationDigest: queued.operation.operationDigest,
      counter: queued.operation.origin.counter,
    };
    break;
  }
  case "accept_push": {
    const response = await acceptReplicationPush(store.db, readJson(config.requestPath), {
      authenticatedReplicaId: config.authenticatedReplicaId,
      authenticatedPrincipalId: config.authenticatedPrincipalId,
      actor: config.actor,
      clock,
    });
    const authority = await getReplicationAuthority(store.db, response.workspaceId);
    receipt = {
      boundary: "authority_accept_committed",
      currentSequence: authority?.currentSequence,
      acknowledgedCounter: response.acknowledgedCounter,
    };
    break;
  }
  case "ack_push": {
    const response = readJson(config.responsePath);
    await acknowledgeReplicationPush(store.db, response, clock);
    receipt = { boundary: "local_ack_committed" };
    break;
  }
  case "install_snapshot": {
    const result = await installReplicationSnapshotAndRebase(
      store.db,
      readJson(config.snapshotPath),
      { clock, actor: config.actor, cursor: config.cursor },
    );
    receipt = {
      boundary: "snapshot_install_committed",
      replayedOperations: result.replayedOperations,
    };
    break;
  }
  case "recover_authority": {
    const recovered = await recoverReplicationAuthority(store.db, {
      workspaceId: config.workspaceId,
      expectedAuthorityReplicaId: config.expectedAuthorityReplicaId,
      expectedAuthorityEpoch: config.expectedAuthorityEpoch,
      expectedCurrentSequence: config.expectedCurrentSequence,
      newAuthorityEpoch: config.newAuthorityEpoch,
      reason: config.reason,
      clock,
    });
    receipt = {
      boundary: "authority_recovery_committed",
      authorityEpoch: recovered.authority.authorityEpoch,
      snapshotDigest: recovered.snapshot.snapshotDigest,
    };
    break;
  }
  case "create_commitment": {
    const commitment = await createCommitment(store.db, { title: config.title }, {
      workspaceId: config.workspaceId,
      actor: config.actor,
      clock,
    });
    receipt = { boundary: "delivery_intent_committed", commitmentId: commitment.id };
    break;
  }
  case "lease_delivery": {
    const leased = await leaseNextDelivery(store.db, config.sinkId, {
      tenantId: config.tenantId,
      leaseOwner: config.leaseOwner,
      leaseMs: config.leaseMs,
      clock,
    });
    if (!leased) throw new Error("Expected a leaseable delivery head");
    receipt = {
      boundary: "delivery_lease_committed",
      deliveryId: leased.delivery.id,
      eventId: leased.event.id,
      eventSequence: leased.event.sequence,
      leaseExpiresAt: leased.delivery.leaseExpiresAt,
    };
    break;
  }
  case "apply_external_effect": {
    writeFileSync(config.receiptPath, JSON.stringify({
      eventId: config.eventId,
      sequence: config.eventSequence,
    }), { encoding: "utf8", mode: 0o600, flag: "wx" });
    receipt = {
      boundary: "external_effect_committed",
      eventId: config.eventId,
      eventSequence: config.eventSequence,
    };
    break;
  }
  case "complete_delivery": {
    const delivery = await completeDelivery(store.db, config.deliveryId, {
      tenantId: config.tenantId,
      leaseOwner: config.leaseOwner,
      clock,
    });
    receipt = {
      boundary: "delivery_ack_committed",
      deliveryId: delivery.id,
      deliveredAt: delivery.deliveredAt,
    };
    break;
  }
}

process.stdout.write(`${JSON.stringify(receipt)}\n`);

// Keep stdin open so the process remains killable at the exact post-commit
// boundary. SIGKILL deliberately bypasses store.close() and every handler.
process.stdin.resume();
await new Promise<void>((resolve) => process.stdin.once("end", resolve));
