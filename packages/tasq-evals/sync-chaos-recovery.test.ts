/**
 * TQ-406 black-box durability proof.
 *
 * Every crash receipt is emitted by a separate process only after its SQLite
 * transaction resolves. The harness then SIGKILLs that process and judges the
 * reopened files, never the dead process's memory. All domain/retention time
 * comes from explicit mutable clocks.
 */

import { afterEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  REPLICATION_PUSH_CONTRACT_VERSION,
  createMutableClock,
  type ReplicationPushRequest,
} from "@tasq-run/schema";
import {
  REPLICATION_RETENTION,
  acceptReplicationPush,
  acknowledgeReplicationPush,
  buildReplicationPushRequest,
  createPrincipal,
  ensureDeliverySink,
  getCommitment,
  getReplicationAuthority,
  getReplicationSnapshot,
  initializeLocalReplica,
  initializeReplicationAuthority,
  installReplicationSnapshotAndRebase,
  leaseNextDelivery,
  listDeliveryOutbox,
  listPendingReplicationOperations,
  listReplicationAuthorityRecoveries,
  listReplicationConflicts,
  localPrincipalId,
  openDb,
  pruneReplicationHistory,
  pullReplication,
  queueReplicatedCommitmentUpdate,
  recoverReplicationAuthority,
  registerReplicationReplica,
  runKernelMigrations,
  verifyDatabaseFile,
  type OpenedDb,
} from "@tasq-run/core";

setDefaultTimeout(60_000);

const here = dirname(fileURLToPath(import.meta.url));
const worker = join(here, "fixtures", "sync-chaos-worker.ts");
const WORKSPACE = "tq406-sync-chaos";
const AUTHORITY_REPLICA = "019d1000-0000-7000-8000-000000000001";
const AUTHORITY_EPOCH = "019d1000-0000-7000-8000-000000000002";
const RECOVERED_EPOCH = "019d1000-0000-7000-8000-000000000003";
const REPLICA_A = "019d1000-0000-7000-8000-00000000000a";
const GENERATION_A = "019d1000-0000-7000-8000-00000000001a";
const REPLICA_B = "019d1000-0000-7000-8000-00000000000b";
const GENERATION_B = "019d1000-0000-7000-8000-00000000001b";
const REPLICA_C = "019d1000-0000-7000-8000-00000000000c";
const GENERATION_C = "019d1000-0000-7000-8000-00000000001c";
const COMMITMENT_ID = "019d1000-0000-7000-8000-000000000100";
const NOW = 1_950_000_000_000;

const roots: string[] = [];
let configCounter = 0;

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function temporary(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
}

async function store(path: string, migrate = false): Promise<OpenedDb> {
  const opened = await openDb({ url: `file:${path}`, wal: true });
  if (migrate) await runKernelMigrations(opened.client, { clock: createMutableClock(NOW) });
  return opened;
}

async function crashAfterCommit(root: string, config: Record<string, unknown>) {
  const configPath = join(root, `boundary-${++configCounter}.json`);
  writeJson(configPath, config);
  const child = Bun.spawn([process.execPath, "run", worker], {
    env: { ...process.env, TASQ_SYNC_CHAOS_CONFIG: configPath },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let output = "";
  while (!output.includes("\n")) {
    const chunk = await reader.read();
    if (chunk.done) break;
    output += decoder.decode(chunk.value, { stream: true });
  }
  if (!output.includes("\n")) {
    const exitCode = await child.exited;
    const stderr = await new Response(child.stderr).text();
    throw new Error(`Chaos worker exited ${exitCode} before its commit receipt: ${stderr}`);
  }
  const receipt = JSON.parse(output.slice(0, output.indexOf("\n")));
  child.kill("SIGKILL");
  const exitCode = await child.exited;
  await reader.cancel().catch(() => {});
  expect(exitCode).not.toBe(0);
  return receipt as Record<string, unknown>;
}

async function register(
  authority: OpenedDb,
  client: OpenedDb,
  replicaId: string,
  generationId: string,
  epoch: string,
  now = NOW,
): Promise<void> {
  const clock = createMutableClock(now);
  await registerReplicationReplica(authority.db, {
    workspaceId: WORKSPACE,
    replicaId,
    generationId,
    clock,
  });
  await initializeLocalReplica(client.db, {
    workspaceId: WORKSPACE,
    replicaId,
    generationId,
    authorityReplicaId: AUTHORITY_REPLICA,
    authorityEpoch: epoch,
    clock,
  });
}

describe("TQ-406 sync chaos and recovery", () => {
  it("survives every external commit boundary, hostile transport order, divergence, expiry and old-backup failover", async () => {
    const root = temporary("tasq-tq406-sync-");
    const authorityPath = join(root, "authority.sqlite");
    const aPath = join(root, "replica-a.sqlite");
    const bPath = join(root, "replica-b.sqlite");
    let authority = await store(authorityPath, true);
    let a = await store(aPath, true);
    let b = await store(bPath, true);
    const authorityClock = createMutableClock(NOW);
    const aClock = createMutableClock(NOW);
    const bClock = createMutableClock(NOW);
    await initializeReplicationAuthority(authority.db, {
      workspaceId: WORKSPACE,
      authorityReplicaId: AUTHORITY_REPLICA,
      authorityEpoch: AUTHORITY_EPOCH,
      clock: authorityClock,
    });
    await register(authority, a, REPLICA_A, GENERATION_A, AUTHORITY_EPOCH);
    await register(authority, b, REPLICA_B, GENERATION_B, AUTHORITY_EPOCH);
    const principalA = localPrincipalId(WORKSPACE, "agent-a");
    const principalB = localPrincipalId(WORKSPACE, "agent-b");
    await createPrincipal(authority.db, {
      tenantId: WORKSPACE,
      kind: "agent",
      displayName: "agent-a",
      localAlias: "agent-a",
    }, { actor: "authority-bootstrap", now: NOW });
    await createPrincipal(authority.db, {
      tenantId: WORKSPACE,
      kind: "agent",
      displayName: "agent-b",
      localAlias: "agent-b",
    }, { actor: "authority-bootstrap", now: NOW });
    await Promise.all([a.close(), b.close()]);

    // 1. Local domain mutation + outgoing operation commit, then hard death.
    expect(await crashAfterCommit(root, {
      action: "queue_create",
      dbPath: aPath,
      now: NOW + 10,
      workspaceId: WORKSPACE,
      actor: "agent-a",
      commitmentId: COMMITMENT_ID,
      title: "Calibrate the universal robot cell",
    })).toMatchObject({ boundary: "local_operation_committed", counter: 1 });
    a = await store(aPath);
    expect(await getCommitment(a.db, COMMITMENT_ID, WORKSPACE)).toMatchObject({
      title: "Calibrate the universal robot cell",
    });
    expect(await listPendingReplicationOperations(a.db, WORKSPACE)).toHaveLength(1);
    const createRequest = await buildReplicationPushRequest(a.db, WORKSPACE);
    const createRequestPath = join(root, "create-request.json");
    writeJson(createRequestPath, createRequest);

    // 2. Authority commit, response loss, restart, exact request replay.
    await authority.close();
    expect(await crashAfterCommit(root, {
      action: "accept_push",
      dbPath: authorityPath,
      now: NOW + 20,
      requestPath: createRequestPath,
      authenticatedReplicaId: REPLICA_A,
      authenticatedPrincipalId: principalA,
      actor: "agent-a",
    })).toMatchObject({ boundary: "authority_accept_committed", currentSequence: 1 });
    authority = await store(authorityPath);
    authorityClock.set(NOW + 20);
    expect(await getReplicationAuthority(authority.db, WORKSPACE)).toMatchObject({ currentSequence: 1 });
    const createResponse = await acceptReplicationPush(authority.db, createRequest, {
      authenticatedReplicaId: REPLICA_A,
      authenticatedPrincipalId: principalA,
      actor: "agent-a",
      clock: authorityClock,
    });
    expect(createResponse.results[0]).toMatchObject({ disposition: "applied", authoritySequence: 1 });
    expect((await getReplicationAuthority(authority.db, WORKSPACE))?.currentSequence).toBe(1);
    const createResponsePath = join(root, "create-response.json");
    writeJson(createResponsePath, createResponse);

    // 3. Local acknowledgement commit, hard death, duplicated ack replay.
    await a.close();
    expect(await crashAfterCommit(root, {
      action: "ack_push",
      dbPath: aPath,
      now: NOW + 30,
      responsePath: createResponsePath,
    })).toMatchObject({ boundary: "local_ack_committed" });
    a = await store(aPath);
    expect(await listPendingReplicationOperations(a.db, WORKSPACE)).toHaveLength(0);
    await acknowledgeReplicationPush(a.db, createResponse, aClock);

    // Establish the same explicit base on both disconnected replicas.
    b = await store(bPath);
    const sharedBase = await getReplicationSnapshot(authority.db, WORKSPACE);
    await installReplicationSnapshotAndRebase(a.db, sharedBase, { clock: aClock, actor: "agent-a" });
    await installReplicationSnapshotAndRebase(b.db, sharedBase, { clock: bClock, actor: "agent-b" });

    // Two chained operations arrive backwards. The gap fails without mutating;
    // the complete retry then applies once, and a duplicate push is exact.
    aClock.set(NOW + 40);
    await queueReplicatedCommitmentUpdate(a.db, COMMITMENT_ID, { title: "Canonical A title" }, {
      workspaceId: WORKSPACE, actor: "agent-a", clock: aClock,
    });
    aClock.set(NOW + 41);
    await queueReplicatedCommitmentUpdate(a.db, COMMITMENT_ID, { description: "Canonical A detail" }, {
      workspaceId: WORKSPACE, actor: "agent-a", clock: aClock,
    });
    const ordered = await buildReplicationPushRequest(a.db, WORKSPACE);
    const reversedTail: ReplicationPushRequest = {
      contractVersion: REPLICATION_PUSH_CONTRACT_VERSION,
      workspaceId: ordered.workspaceId,
      replicaId: ordered.replicaId,
      generationId: ordered.generationId,
      operations: [ordered.operations[1]!],
    };
    authorityClock.set(NOW + 50);
    await expect(acceptReplicationPush(authority.db, reversedTail, {
      authenticatedReplicaId: REPLICA_A,
      authenticatedPrincipalId: principalA,
      actor: "agent-a",
      clock: authorityClock,
    })).rejects.toMatchObject({ code: "origin_gap" });
    expect((await getReplicationAuthority(authority.db, WORKSPACE))?.currentSequence).toBe(1);
    const orderedResponse = await acceptReplicationPush(authority.db, ordered, {
      authenticatedReplicaId: REPLICA_A,
      authenticatedPrincipalId: principalA,
      actor: "agent-a",
      clock: authorityClock,
    });
    const duplicateResponse = await acceptReplicationPush(authority.db, ordered, {
      authenticatedReplicaId: REPLICA_A,
      authenticatedPrincipalId: principalA,
      actor: "agent-a",
      clock: authorityClock,
    });
    expect(duplicateResponse).toEqual(orderedResponse);
    expect((await getReplicationAuthority(authority.db, WORKSPACE))?.currentSequence).toBe(3);
    await acknowledgeReplicationPush(a.db, orderedResponse, aClock);
    await acknowledgeReplicationPush(a.db, orderedResponse, aClock);

    // B edits the old base with an absurdly earlier device clock. Arrival and
    // base digests, never device time, choose canonical state and expose B.
    bClock.set(1);
    await queueReplicatedCommitmentUpdate(b.db, COMMITMENT_ID, { title: "Offline B title" }, {
      workspaceId: WORKSPACE, actor: "agent-b", clock: bClock,
    });
    authorityClock.set(NOW + 60);
    const bResponse = await acceptReplicationPush(
      authority.db,
      await buildReplicationPushRequest(b.db, WORKSPACE),
      {
        authenticatedReplicaId: REPLICA_B,
        authenticatedPrincipalId: principalB,
        actor: "agent-b",
        clock: authorityClock,
      },
    );
    expect(bResponse.results[0]).toMatchObject({
      disposition: "conflicted",
      conflict: {
        reason: "concurrent_mutation",
        baseSnapshot: { title: "Calibrate the universal robot cell" },
        authoritySnapshot: { title: "Canonical A title", description: "Canonical A detail" },
        incomingSnapshot: { title: "Offline B title" },
      },
    });
    await acknowledgeReplicationPush(b.db, bResponse, bClock);
    const conflicts = await listReplicationConflicts(authority.db, WORKSPACE);
    expect(conflicts).toHaveLength(1);

    // Every active generation acknowledges the frontier. Only the injected
    // authority clock advances retention and expires the old sequence-1 cursor.
    const currentA = await pullReplication(authority.db, {
      workspaceId: WORKSPACE,
      replicaId: REPLICA_A,
      generationId: GENERATION_A,
      authenticatedReplicaId: REPLICA_A,
      cursor: null,
      clock: authorityClock,
    });
    const currentB = await pullReplication(authority.db, {
      workspaceId: WORKSPACE,
      replicaId: REPLICA_B,
      generationId: GENERATION_B,
      authenticatedReplicaId: REPLICA_B,
      cursor: null,
      clock: authorityClock,
    });
    expect(currentA.disposition).toBe("incremental");
    expect(currentB.disposition).toBe("incremental");
    await installReplicationSnapshotAndRebase(a.db, currentA.snapshot, {
      clock: aClock,
      actor: "agent-a",
      cursor: currentA.nextCursor,
    });
    authorityClock.advance(REPLICATION_RETENTION.operationMinimumMs + 1);
    const pruned = await pruneReplicationHistory(authority.db, WORKSPACE, authorityClock);
    expect(pruned).toEqual({ pruned: 4, minimumRetainedSequence: 4 });
    const expired = await pullReplication(authority.db, {
      workspaceId: WORKSPACE,
      replicaId: REPLICA_B,
      generationId: GENERATION_B,
      authenticatedReplicaId: REPLICA_B,
      cursor: createResponse.cursor,
      clock: authorityClock,
    });
    expect(expired.disposition).toBe("cursor_expired");
    if (expired.disposition !== "cursor_expired") throw new Error("Expected cursor expiry");
    expect(expired.snapshot.unresolvedConflicts).toEqual(conflicts);

    // 4. Verified snapshot install/rebase commit, then hard death.
    const expiredSnapshotPath = join(root, "expired-snapshot.json");
    writeJson(expiredSnapshotPath, expired.snapshot);
    await b.close();
    expect(await crashAfterCommit(root, {
      action: "install_snapshot",
      dbPath: bPath,
      now: 2,
      snapshotPath: expiredSnapshotPath,
      actor: "agent-b",
      cursor: expired.nextCursor,
    })).toMatchObject({ boundary: "snapshot_install_committed", replayedOperations: 0 });
    b = await store(bPath);
    expect(await getCommitment(b.db, COMMITMENT_ID, WORKSPACE)).toMatchObject({
      title: "Canonical A title",
      description: "Canonical A detail",
    });
    expect(await listReplicationConflicts(b.db, WORKSPACE)).toEqual(conflicts);

    // Capture a verified authority backup at sequence 4, then let the live
    // lineage accept sequence 5 so the restored copy is observably old.
    const backupPath = join(root, "authority-sequence-4.sqlite");
    await authority.client.execute({ sql: "VACUUM INTO ?", args: [backupPath] });
    expect(await verifyDatabaseFile(backupPath)).toMatchObject({ ok: true });
    aClock.set(3);
    await queueReplicatedCommitmentUpdate(a.db, COMMITMENT_ID, { priority: 5 }, {
      workspaceId: WORKSPACE, actor: "agent-a", clock: aClock,
    });
    const postBackupRequest = await buildReplicationPushRequest(a.db, WORKSPACE);
    authorityClock.advance(10);
    const postBackupResponse = await acceptReplicationPush(authority.db, postBackupRequest, {
      authenticatedReplicaId: REPLICA_A,
      authenticatedPrincipalId: principalA,
      actor: "agent-a",
      clock: authorityClock,
    });
    await acknowledgeReplicationPush(a.db, postBackupResponse, aClock);
    const sourceHead = await pullReplication(authority.db, {
      workspaceId: WORKSPACE,
      replicaId: REPLICA_A,
      generationId: GENERATION_A,
      authenticatedReplicaId: REPLICA_A,
      cursor: currentA.nextCursor,
      clock: authorityClock,
    });
    expect(sourceHead.snapshot.coveredSequence).toBe(5);
    await installReplicationSnapshotAndRebase(a.db, sourceHead.snapshot, {
      clock: aClock,
      actor: "agent-a",
      cursor: sourceHead.nextCursor,
    });

    let restored = await store(backupPath);
    const restoredIdentity = await getReplicationAuthority(restored.db, WORKSPACE);
    expect(restoredIdentity).toMatchObject({
      authorityEpoch: AUTHORITY_EPOCH,
      currentSequence: 4,
      minimumRetainedSequence: 4,
    });
    const regression = await pullReplication(restored.db, {
      workspaceId: WORKSPACE,
      replicaId: REPLICA_A,
      generationId: GENERATION_A,
      authenticatedReplicaId: REPLICA_A,
      cursor: sourceHead.nextCursor,
      clock: authorityClock,
    });
    expect(regression.disposition).toBe("cursor_expired");
    if (regression.disposition !== "cursor_expired") throw new Error("Expected restored cursor expiry");
    await expect(installReplicationSnapshotAndRebase(a.db, regression.snapshot, {
      clock: aClock,
      actor: "agent-a",
      cursor: regression.nextCursor,
    })).rejects.toThrow("regressed without the mandatory authority epoch rotation");

    // 5. Recovery epoch + durable receipt commit, then hard death. Exact retry
    // reconstructs the same snapshot and old-epoch operations stay fenced out.
    const recoveryNow = authorityClock.now() + 10;
    await restored.close();
    expect(await crashAfterCommit(root, {
      action: "recover_authority",
      dbPath: backupPath,
      now: recoveryNow,
      workspaceId: WORKSPACE,
      expectedAuthorityReplicaId: AUTHORITY_REPLICA,
      expectedAuthorityEpoch: AUTHORITY_EPOCH,
      expectedCurrentSequence: 4,
      newAuthorityEpoch: RECOVERED_EPOCH,
      reason: "TQ-406 verified old-backup disaster recovery",
    })).toMatchObject({ boundary: "authority_recovery_committed", authorityEpoch: RECOVERED_EPOCH });
    restored = await store(backupPath);
    const recovered = await recoverReplicationAuthority(restored.db, {
      workspaceId: WORKSPACE,
      expectedAuthorityReplicaId: AUTHORITY_REPLICA,
      expectedAuthorityEpoch: AUTHORITY_EPOCH,
      expectedCurrentSequence: 4,
      newAuthorityEpoch: RECOVERED_EPOCH,
      reason: "TQ-406 verified old-backup disaster recovery",
      clock: createMutableClock(recoveryNow),
    });
    expect(recovered.authority).toMatchObject({ authorityEpoch: RECOVERED_EPOCH, currentSequence: 4 });
    expect(await listReplicationAuthorityRecoveries(restored.db, WORKSPACE)).toEqual([
      recovered.recovery,
    ]);
    await expect(acceptReplicationPush(restored.db, postBackupRequest, {
      authenticatedReplicaId: REPLICA_A,
      authenticatedPrincipalId: principalA,
      actor: "agent-a",
      clock: createMutableClock(recoveryNow),
    })).rejects.toMatchObject({ code: "authority_epoch_mismatch" });
    await expect(pullReplication(restored.db, {
      workspaceId: WORKSPACE,
      replicaId: REPLICA_A,
      generationId: GENERATION_A,
      authenticatedReplicaId: REPLICA_A,
      cursor: sourceHead.nextCursor,
      clock: createMutableClock(recoveryNow),
    })).rejects.toMatchObject({ code: "replica_stale" });

    // A fresh machine uses a fresh generation, installs the recovered
    // snapshot, and can advance the new lineage without seeing lost seq 5.
    const cPath = join(root, "fresh-replica-c.sqlite");
    const c = await store(cPath, true);
    const cClock = createMutableClock(4);
    await createPrincipal(restored.db, {
      tenantId: WORKSPACE,
      kind: "agent",
      displayName: "agent-c",
      localAlias: "agent-c",
    }, { actor: "recovery-bootstrap", now: recoveryNow + 1 });
    const principalC = localPrincipalId(WORKSPACE, "agent-c");
    await register(restored, c, REPLICA_C, GENERATION_C, RECOVERED_EPOCH, recoveryNow + 1);
    const recoverySnapshot = await getReplicationSnapshot(restored.db, WORKSPACE);
    await installReplicationSnapshotAndRebase(c.db, recoverySnapshot, { clock: cClock, actor: "agent-c" });
    expect(await getCommitment(c.db, COMMITMENT_ID, WORKSPACE)).toMatchObject({
      title: "Canonical A title",
      priority: null,
    });
    await queueReplicatedCommitmentUpdate(c.db, COMMITMENT_ID, {
      description: "Recovered lineage is writable",
    }, { workspaceId: WORKSPACE, actor: "agent-c", clock: cClock });
    const recoveredWrite = await acceptReplicationPush(
      restored.db,
      await buildReplicationPushRequest(c.db, WORKSPACE),
      {
        authenticatedReplicaId: REPLICA_C,
        authenticatedPrincipalId: principalC,
        actor: "agent-c",
        clock: createMutableClock(recoveryNow + 2),
      },
    );
    expect(recoveredWrite.results[0]).toMatchObject({ disposition: "applied", authoritySequence: 5 });
    expect(await getCommitment(restored.db, COMMITMENT_ID, WORKSPACE)).toMatchObject({
      priority: null,
      description: "Recovered lineage is writable",
    });

    await Promise.all([authority.close(), a.close(), b.close(), restored.close(), c.close()]);
  });

  it("survives real outbox intent, lease and acknowledgement crashes without duplicate sink work", async () => {
    const root = temporary("tasq-tq406-outbox-");
    const dbPath = join(root, "ledger.sqlite");
    const sinkId = "robot-cell:durable-audit";
    const tenantId = "tq406-outbox";
    const base = NOW + 10_000_000;
    let handle = await store(dbPath, true);
    await ensureDeliverySink(handle.db, {
      id: sinkId,
      kind: "urn:example:robot-cell-audit:v1",
      configurationDigest: `sha256:${"4".repeat(64)}`,
    }, { tenantId, clock: createMutableClock(base) });
    await handle.close();

    const created = await crashAfterCommit(root, {
      action: "create_commitment",
      dbPath,
      now: base + 1,
      workspaceId: tenantId,
      actor: "robot-coordinator",
      title: "Persist calibration result",
    });
    expect(created).toMatchObject({ boundary: "delivery_intent_committed" });
    handle = await store(dbPath);
    expect(await listDeliveryOutbox(handle.db, { tenantId, sinkId })).toHaveLength(1);
    await handle.close();

    const firstLease = await crashAfterCommit(root, {
      action: "lease_delivery",
      dbPath,
      now: base + 2,
      tenantId,
      sinkId,
      leaseOwner: "dead-drainer",
      leaseMs: 100,
    });
    expect(firstLease).toMatchObject({ boundary: "delivery_lease_committed", leaseExpiresAt: base + 102 });
    handle = await store(dbPath);
    expect(await leaseNextDelivery(handle.db, sinkId, {
      tenantId,
      leaseOwner: "replacement",
      leaseMs: 100,
      clock: createMutableClock(base + 101),
    })).toBeNull();
    const replacement = await leaseNextDelivery(handle.db, sinkId, {
      tenantId,
      leaseOwner: "replacement",
      leaseMs: 100,
      clock: createMutableClock(base + 102),
    });
    expect(replacement).toMatchObject({
      delivery: { id: firstLease.deliveryId, attemptCount: 2 },
      event: { id: firstLease.eventId, sequence: firstLease.eventSequence },
    });

    // The external sink is keyed by immutable event identity. Kill the real
    // worker after the sink receipt commits but before Tasq can record its ack.
    const externalReceipt = join(root, "external-sink-receipt.json");
    await handle.close();
    expect(await crashAfterCommit(root, {
      action: "apply_external_effect",
      dbPath,
      now: base + 103,
      receiptPath: externalReceipt,
      eventId: replacement!.event.id,
      eventSequence: replacement!.event.sequence,
    })).toMatchObject({ boundary: "external_effect_committed" });

    // A receipt-aware replacement waits for exact injected lease expiry,
    // observes the existing sink identity, performs no second write, and acks.
    handle = await store(dbPath);
    expect(await leaseNextDelivery(handle.db, sinkId, {
      tenantId,
      leaseOwner: "receipt-aware",
      leaseMs: 100,
      clock: createMutableClock(base + 201),
    })).toBeNull();
    const receiptAware = await leaseNextDelivery(handle.db, sinkId, {
      tenantId,
      leaseOwner: "receipt-aware",
      leaseMs: 100,
      clock: createMutableClock(base + 202),
    });
    expect(receiptAware).toMatchObject({
      delivery: { id: firstLease.deliveryId, attemptCount: 3 },
      event: { id: replacement!.event.id, sequence: replacement!.event.sequence },
    });
    expect(JSON.parse(readFileSync(externalReceipt, "utf8"))).toEqual({
      eventId: receiptAware!.event.id,
      sequence: receiptAware!.event.sequence,
    });
    await handle.close();
    expect(await crashAfterCommit(root, {
      action: "complete_delivery",
      dbPath,
      now: base + 203,
      tenantId,
      deliveryId: receiptAware!.delivery.id,
      leaseOwner: "receipt-aware",
    })).toMatchObject({ boundary: "delivery_ack_committed", deliveredAt: base + 203 });
    handle = await store(dbPath);
    expect(JSON.parse(readFileSync(externalReceipt, "utf8"))).toEqual({
      eventId: receiptAware!.event.id,
      sequence: receiptAware!.event.sequence,
    });
    expect(await listDeliveryOutbox(handle.db, { tenantId, sinkId })).toEqual([
      expect.objectContaining({ status: "delivered", attemptCount: 3, deliveredAt: base + 203 }),
    ]);
    expect(await leaseNextDelivery(handle.db, sinkId, {
      tenantId,
      leaseOwner: "late-duplicate",
      leaseMs: 100,
      clock: createMutableClock(base + 1_000),
    })).toBeNull();
    expect(await getCommitment(handle.db, String(created.commitmentId), tenantId)).toMatchObject({
      title: "Persist calibration result",
    });
    await handle.close();
  });

  it("contains no raw wall-clock source in the crash worker", () => {
    const source = readFileSync(worker, "utf8").toLowerCase();
    for (const forbidden of [
      "date.now",
      "new date(",
      "performance.now",
      "time.time",
      "time_ns",
      "strftime(",
      "unixepoch(",
    ]) {
      expect(source, `worker contains raw clock source: ${forbidden}`).not.toContain(forbidden);
    }
  });
});
