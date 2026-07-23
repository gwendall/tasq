import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  REPLICATION_RETENTION,
  ReplicationProtocolError,
  acceptReplicationPush,
  acknowledgeReplicationPush,
  assembleReplicationSnapshotPages,
  buildReplicationPushRequest,
  computeReplicationOperationDigest,
  computeReplicationSnapshotDigest,
  computeReplicatedCommitmentStateDigest,
  createPrincipal,
  getReplicationAuthority,
  getReplicationSnapshot,
  getTask,
  getTasqDiscovery,
  initializeLocalReplica,
  initializeReplicationAuthority,
  installReplicationSnapshotAndRebase,
  listPendingReplicationOperations,
  listReplicationConflicts,
  localPrincipalId,
  openDb,
  paginateReplicationSnapshot,
  pruneReplicationHistory,
  pullReplication,
  queueReplicatedCommitmentCreate,
  queueReplicatedCommitmentDelete,
  queueReplicatedCommitmentUpdate,
  registerReplicationReplica,
  retireReplicatedCommitment,
  runMigrations,
  updateTask,
  type OpenedDb,
} from "../src/index.js";
import {
  REPLICATION_PUSH_CONTRACT_VERSION,
  ReplicationOperation,
  createMutableClock,
  uuidv7,
} from "@tasq-run/schema";

const WORKSPACE = "replication-test";
const AUTHORITY_REPLICA = "019d0000-0000-7000-8000-000000000001";
const AUTHORITY_EPOCH = "019d0000-0000-7000-8000-000000000002";
const REPLICA_A = "019d0000-0000-7000-8000-00000000000a";
const GENERATION_A = "019d0000-0000-7000-8000-00000000001a";
const REPLICA_B = "019d0000-0000-7000-8000-00000000000b";
const GENERATION_B = "019d0000-0000-7000-8000-00000000001b";
const REPLICA_C = "019d0000-0000-7000-8000-00000000000c";
const GENERATION_C = "019d0000-0000-7000-8000-00000000001c";
const REPLICA_D = "019d0000-0000-7000-8000-00000000000d";
const GENERATION_D = "019d0000-0000-7000-8000-00000000001d";
const COMMITMENT_ID = "019d0000-0000-7000-8000-000000000100";
const NOW = 1_900_000_000_000;

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

async function store(label: string): Promise<OpenedDb> {
  const dir = mkdtempSync(join(tmpdir(), `tasq-replication-${label}-`));
  tmpDirs.push(dir);
  const opened = await openDb({ url: `file:${join(dir, "db.sqlite")}`, wal: false });
  await runMigrations(opened.client, { now: NOW, installReferenceExtension: false });
  return opened;
}

async function principal(authority: OpenedDb, alias: string, now = NOW): Promise<string> {
  const id = localPrincipalId(WORKSPACE, alias);
  await createPrincipal(authority.db, {
    tenantId: WORKSPACE,
    kind: "agent",
    displayName: alias,
    localAlias: alias,
  }, { now, actor: "authority-bootstrap" });
  return id;
}

async function addReplica(
  authority: OpenedDb,
  client: OpenedDb,
  replicaId: string,
  generationId: string,
  clock: ReturnType<typeof createMutableClock>,
): Promise<void> {
  await registerReplicationReplica(authority.db, { workspaceId: WORKSPACE, replicaId, generationId, clock });
  await initializeLocalReplica(client.db, {
    workspaceId: WORKSPACE,
    replicaId,
    generationId,
    authorityReplicaId: AUTHORITY_REPLICA,
    authorityEpoch: AUTHORITY_EPOCH,
    clock,
  });
}

async function bootstrapTwoReplicas() {
  const authority = await store("authority");
  const a = await store("a");
  const b = await store("b");
  const authorityClock = createMutableClock(NOW);
  const aClock = createMutableClock(NOW);
  const bClock = createMutableClock(NOW);
  await initializeReplicationAuthority(authority.db, {
    workspaceId: WORKSPACE,
    authorityReplicaId: AUTHORITY_REPLICA,
    authorityEpoch: AUTHORITY_EPOCH,
    clock: authorityClock,
  });
  await addReplica(authority, a, REPLICA_A, GENERATION_A, aClock);
  await addReplica(authority, b, REPLICA_B, GENERATION_B, bClock);
  const principalA = await principal(authority, "agent-a");
  const principalB = await principal(authority, "agent-b");

  const created = await queueReplicatedCommitmentCreate(a.db, {
    id: COMMITMENT_ID,
    title: "shared base",
    description: "created offline",
  }, { workspaceId: WORKSPACE, actor: "agent-a", clock: aClock });
  const createRequest = await buildReplicationPushRequest(a.db, WORKSPACE);
  const createResponse = await acceptReplicationPush(authority.db, createRequest, {
    authenticatedReplicaId: REPLICA_A,
    authenticatedPrincipalId: principalA,
    actor: "agent-a",
    clock: authorityClock,
  });
  expect(createResponse.results[0]?.disposition).toBe("applied");
  await acknowledgeReplicationPush(a.db, createResponse, aClock);
  const snapshot = await getReplicationSnapshot(authority.db, WORKSPACE);
  await installReplicationSnapshotAndRebase(a.db, snapshot, { clock: aClock, actor: "agent-a" });
  await installReplicationSnapshotAndRebase(b.db, snapshot, { clock: bClock, actor: "agent-b" });
  expect((await getTask(b.db, created.commitment.id, WORKSPACE))?.title).toBe("shared base");
  return { authority, a, b, authorityClock, aClock, bClock, principalA, principalB, snapshot };
}

describe("TQ-405 explicit replication", () => {
  it("rejects values that cannot participate in canonical replication JSON", () => {
    expect(() => computeReplicationOperationDigest({ illegal: undefined } as never))
      .toThrow("not canonically serializable");
    expect(() => computeReplicationOperationDigest({ illegal: 1.5 } as never))
      .toThrow("safe integer");
  });

  it("rolls back the domain row and audit when outgoing capture cannot commit", async () => {
    const client = await store("atomic");
    const clock = createMutableClock(NOW);
    await initializeLocalReplica(client.db, {
      workspaceId: WORKSPACE,
      replicaId: REPLICA_A,
      generationId: GENERATION_A,
      authorityReplicaId: AUTHORITY_REPLICA,
      authorityEpoch: AUTHORITY_EPOCH,
      clock,
    });
    await client.client.execute("DROP TABLE replication_outgoing_operation");

    await expect(queueReplicatedCommitmentCreate(client.db, {
      id: COMMITMENT_ID,
      title: "must roll back",
    }, { workspaceId: WORKSPACE, actor: "agent-a", clock })).rejects.toThrow();
    expect(await getTask(client.db, COMMITMENT_ID, WORKSPACE)).toBeNull();
    const eventCount = await client.client.execute("SELECT count(*) AS count FROM event");
    expect(Number(eventCount.rows[0]?.count)).toBe(0);
    await client.close();
  });

  it("rolls back authority application when the accepted log cannot commit", async () => {
    const authority = await store("authority-atomic");
    const client = await store("client-atomic");
    const clock = createMutableClock(NOW);
    try {
      await initializeReplicationAuthority(authority.db, {
        workspaceId: WORKSPACE,
        authorityReplicaId: AUTHORITY_REPLICA,
        authorityEpoch: AUTHORITY_EPOCH,
        clock,
      });
      await addReplica(authority, client, REPLICA_A, GENERATION_A, clock);
      const principalA = await principal(authority, "agent-a");
      await queueReplicatedCommitmentCreate(client.db, {
        id: COMMITMENT_ID,
        title: "authority must roll back",
      }, { workspaceId: WORKSPACE, actor: "agent-a", clock });
      const request = await buildReplicationPushRequest(client.db, WORKSPACE);
      await authority.client.execute("DROP TABLE replication_accepted_operation");

      await expect(acceptReplicationPush(authority.db, request, {
        authenticatedReplicaId: REPLICA_A,
        authenticatedPrincipalId: principalA,
        actor: "agent-a",
        clock,
      })).rejects.toThrow();
      expect(await getTask(authority.db, COMMITMENT_ID, WORKSPACE)).toBeNull();
      expect((await getReplicationAuthority(authority.db, WORKSPACE))?.currentSequence).toBe(0);
    } finally {
      await Promise.all([authority.close(), client.close()]);
    }
  });

  it("preserves an accepted operation identity when its push response was lost", async () => {
    const h = await bootstrapTwoReplicas();
    try {
      await queueReplicatedCommitmentUpdate(h.a.db, COMMITMENT_ID, {
        description: "accepted before response loss",
      }, { workspaceId: WORKSPACE, actor: "agent-a", clock: h.aClock });
      const original = (await listPendingReplicationOperations(h.a.db, WORKSPACE))[0]!;
      const lostResponse = await acceptReplicationPush(
        h.authority.db,
        await buildReplicationPushRequest(h.a.db, WORKSPACE),
        {
          authenticatedReplicaId: REPLICA_A,
          authenticatedPrincipalId: h.principalA,
          actor: "agent-a",
          clock: h.authorityClock,
        },
      );

      // A later authority-only mutation means current state no longer equals
      // the lost operation outcome. Only the accepted origin frontier proves
      // that rebasing this dot would be identity corruption.
      h.authorityClock.advance(1);
      await updateTask(h.authority.db, COMMITMENT_ID, { title: "later authority state" }, {
        tenantId: WORKSPACE,
        actor: "authority",
        now: h.authorityClock.now(),
      });
      const snapshot = await getReplicationSnapshot(h.authority.db, WORKSPACE);
      expect(snapshot.acceptedFrontiers).toContainEqual(expect.objectContaining({
        replicaId: REPLICA_A,
        generationId: GENERATION_A,
        acceptedCounter: original.origin.counter,
        acceptedDigest: original.operationDigest,
      }));
      await installReplicationSnapshotAndRebase(h.a.db, snapshot, {
        clock: h.aClock,
        actor: "agent-a",
      });
      const preserved = (await listPendingReplicationOperations(h.a.db, WORKSPACE))[0]!;
      expect(preserved).toEqual(original);
      const exactRetry = await acceptReplicationPush(
        h.authority.db,
        await buildReplicationPushRequest(h.a.db, WORKSPACE),
        {
          authenticatedReplicaId: REPLICA_A,
          authenticatedPrincipalId: h.principalA,
          actor: "agent-a",
          clock: h.authorityClock,
        },
      );
      expect(exactRetry.results).toEqual(lostResponse.results);
      await acknowledgeReplicationPush(h.a.db, exactRetry, h.aClock);
      await acknowledgeReplicationPush(h.a.db, exactRetry, h.aClock);
      expect(await listPendingReplicationOperations(h.a.db, WORKSPACE)).toHaveLength(0);

      const changedAck = {
        ...exactRetry,
        results: exactRetry.results.map((result) => ({
          ...result,
          authoritySequence: result.authoritySequence + 1,
        })),
      };
      await expect(acknowledgeReplicationPush(h.a.db, changedAck, h.aClock))
        .rejects.toMatchObject({ code: "identity_corruption" });
    } finally {
      await Promise.all([h.authority.close(), h.a.close(), h.b.close()]);
    }
  });

  it("paginates, independently verifies, and order-independently assembles snapshots", async () => {
    const h = await bootstrapTwoReplicas();
    try {
      const template = h.snapshot.records[0]!.snapshot;
      const records = Array.from({ length: 501 }, (_, index) => {
        const snapshot = { ...template, id: uuidv7(NOW + index + 1) };
        return {
          recordType: "commitment" as const,
          recordId: snapshot.id,
          stateDigest: computeReplicatedCommitmentStateDigest(snapshot),
          snapshot,
        };
      });
      const { snapshotDigest: _oldSnapshotDigest, ...baseUnsigned } = h.snapshot;
      const unsigned = { ...baseUnsigned, records };
      const expanded = {
        ...unsigned,
        snapshotDigest: computeReplicationSnapshotDigest(unsigned),
      };
      const bundle = paginateReplicationSnapshot(expanded);
      expect(bundle.pages.length).toBeGreaterThan(1);
      expect(assembleReplicationSnapshotPages(bundle.manifest, [...bundle.pages].reverse()))
        .toEqual(expanded);
      expect(() => assembleReplicationSnapshotPages(bundle.manifest, bundle.pages.slice(1)))
        .toThrow("page count mismatch");
      expect(() => assembleReplicationSnapshotPages(bundle.manifest, [
        { ...bundle.pages[0], pageIndex: 1 },
        ...bundle.pages.slice(1),
      ])).toThrow();
    } finally {
      await Promise.all([h.authority.close(), h.a.close(), h.b.close()]);
    }
  });

  it("deduplicates exact retries and preserves a same-base offline loser as a visible conflict", async () => {
    const h = await bootstrapTwoReplicas();
    try {
      // Device time is deliberately absurd in opposite directions. Authority
      // classification must depend only on base digests and arrival order.
      h.aClock.set(2_100_000_000_000);
      h.bClock.set(1);
      await queueReplicatedCommitmentUpdate(h.a.db, COMMITMENT_ID, { title: "agent A" }, {
        workspaceId: WORKSPACE, actor: "agent-a", clock: h.aClock,
      });
      await queueReplicatedCommitmentUpdate(h.b.db, COMMITMENT_ID, { title: "agent B" }, {
        workspaceId: WORKSPACE, actor: "agent-b", clock: h.bClock,
      });
      const requestA = await buildReplicationPushRequest(h.a.db, WORKSPACE);
      const requestB = await buildReplicationPushRequest(h.b.db, WORKSPACE);
      h.authorityClock.advance(10_000);
      const acceptedA = await acceptReplicationPush(h.authority.db, requestA, {
        authenticatedReplicaId: REPLICA_A,
        authenticatedPrincipalId: h.principalA,
        actor: "agent-a",
        clock: h.authorityClock,
      });
      const conflictedB = await acceptReplicationPush(h.authority.db, requestB, {
        authenticatedReplicaId: REPLICA_B,
        authenticatedPrincipalId: h.principalB,
        actor: "agent-b",
        clock: h.authorityClock,
      });
      expect(acceptedA.results[0]?.disposition).toBe("applied");
      expect(conflictedB.results[0]?.disposition).toBe("conflicted");
      expect(await getTask(h.authority.db, COMMITMENT_ID, WORKSPACE)).toMatchObject({
        title: "agent A",
        updatedAt: h.authorityClock.now(),
      });
      const conflicts = await listReplicationConflicts(h.authority.db, WORKSPACE);
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]).toMatchObject({
        reason: "concurrent_mutation",
        baseSnapshot: { title: "shared base" },
        authoritySnapshot: { title: "agent A" },
        incomingSnapshot: { title: "agent B" },
        recordedAt: h.authorityClock.now(),
      });
      await acknowledgeReplicationPush(h.b.db, conflictedB, h.bClock);
      const conflictedSnapshot = await getReplicationSnapshot(h.authority.db, WORKSPACE);
      const { snapshotDigest: _snapshotDigest, ...unsignedSnapshot } = conflictedSnapshot;
      const escapedUnsigned = {
        ...unsignedSnapshot,
        unresolvedConflicts: unsignedSnapshot.unresolvedConflicts.map((conflict) => ({
          ...conflict,
          workspaceId: "another-workspace",
        })),
      };
      await expect(installReplicationSnapshotAndRebase(h.b.db, {
        ...escapedUnsigned,
        snapshotDigest: computeReplicationSnapshotDigest(escapedUnsigned),
      }, { clock: h.bClock, actor: "agent-b" })).rejects.toMatchObject({
        code: "projection_violation",
      });
      await installReplicationSnapshotAndRebase(h.b.db, conflictedSnapshot, {
        clock: h.bClock,
        actor: "agent-b",
      });
      expect(await listReplicationConflicts(h.b.db, WORKSPACE)).toEqual(conflicts);

      const beforeRetry = (await getReplicationAuthority(h.authority.db, WORKSPACE))!.currentSequence;
      const exactRetry = await acceptReplicationPush(h.authority.db, requestB, {
        authenticatedReplicaId: REPLICA_B,
        authenticatedPrincipalId: h.principalB,
        actor: "agent-b",
        clock: h.authorityClock,
      });
      expect(exactRetry).toEqual(conflictedB);
      expect((await getReplicationAuthority(h.authority.db, WORKSPACE))!.currentSequence).toBe(beforeRetry);

      const original = requestB.operations[0]!;
      const { operationDigest: _oldDigest, ...unsignedOriginal } = original;
      const forgedOutcome = {
        ...original.outcomes[0]!.snapshot!,
        title: "forged identity",
      };
      const unsigned = {
        ...unsignedOriginal,
        command: {
          ...original.command,
          input: { id: COMMITMENT_ID, patch: { title: "forged identity" } },
        },
        outcomes: [{
          recordType: "commitment" as const,
          recordId: COMMITMENT_ID,
          stateDigest: computeReplicatedCommitmentStateDigest(forgedOutcome),
          snapshot: forgedOutcome,
        }],
      };
      const forged = ReplicationOperation.parse({
        ...unsigned,
        operationDigest: computeReplicationOperationDigest(unsigned),
      });
      await expect(acceptReplicationPush(h.authority.db, {
        ...requestB,
        operations: [forged],
      }, {
        authenticatedReplicaId: REPLICA_B,
        authenticatedPrincipalId: h.principalB,
        actor: "agent-b",
        clock: h.authorityClock,
      })).rejects.toMatchObject({ code: "identity_corruption" });

      const discovery = await getTasqDiscovery(h.authority.db, {
        workspaceId: WORKSPACE,
        clock: h.authorityClock,
      });
      expect(discovery.replication?.operationRegistry).toContainEqual({
        operationUri: "urn:tasq:replication:claim.authority.v1",
        operationVersion: 1,
        class: "authority_required",
      });
      expect(discovery.capabilities.some((capability) =>
        capability.uri === "https://schemas.tasq.dev/capabilities/replication")).toBe(true);
      expect(JSON.stringify(await getReplicationSnapshot(h.authority.db, WORKSPACE)))
        .not.toContain("delivery_outbox");
    } finally {
      await Promise.all([h.authority.close(), h.a.close(), h.b.close()]);
    }
  });

  it("rebases pending work over a newer canonical snapshot and keeps the chain pushable", async () => {
    const h = await bootstrapTwoReplicas();
    const c = await store("c");
    const d = await store("d");
    const cClock = createMutableClock(NOW + 1_000);
    const dClock = createMutableClock(NOW + 2_000);
    try {
      await addReplica(h.authority, c, REPLICA_C, GENERATION_C, cClock);
      await addReplica(h.authority, d, REPLICA_D, GENERATION_D, dClock);
      const principalC = await principal(h.authority, "agent-c");
      const principalD = await principal(h.authority, "agent-d");
      const registeredSnapshot = await getReplicationSnapshot(h.authority.db, WORKSPACE);
      await installReplicationSnapshotAndRebase(c.db, registeredSnapshot, { clock: cClock, actor: "agent-c" });
      await installReplicationSnapshotAndRebase(d.db, registeredSnapshot, { clock: dClock, actor: "agent-d" });

      await queueReplicatedCommitmentUpdate(c.db, COMMITMENT_ID, { description: "C pending" }, {
        workspaceId: WORKSPACE, actor: "agent-c", clock: cClock,
      });
      const beforeRebase = (await listPendingReplicationOperations(c.db, WORKSPACE))[0]!;
      await queueReplicatedCommitmentUpdate(d.db, COMMITMENT_ID, { title: "D canonical" }, {
        workspaceId: WORKSPACE, actor: "agent-d", clock: dClock,
      });
      const dResponse = await acceptReplicationPush(
        h.authority.db,
        await buildReplicationPushRequest(d.db, WORKSPACE),
        {
          authenticatedReplicaId: REPLICA_D,
          authenticatedPrincipalId: principalD,
          actor: "agent-d",
          clock: h.authorityClock,
        },
      );
      await acknowledgeReplicationPush(d.db, dResponse, dClock);
      const newer = await getReplicationSnapshot(h.authority.db, WORKSPACE);
      const rebased = await installReplicationSnapshotAndRebase(c.db, newer, {
        clock: cClock,
        actor: "agent-c",
      });
      expect(rebased.replayedOperations).toBe(1);
      const afterRebase = (await listPendingReplicationOperations(c.db, WORKSPACE))[0]!;
      expect(afterRebase.operationDigest).not.toBe(beforeRebase.operationDigest);
      expect(afterRebase.causalBase.observedSequence).toBe(newer.coveredSequence);
      expect(afterRebase.preconditions[0]?.snapshot).toMatchObject({ title: "D canonical" });
      expect(afterRebase.outcomes[0]?.snapshot).toMatchObject({
        title: "D canonical",
        description: "C pending",
      });

      const cResponse = await acceptReplicationPush(
        h.authority.db,
        await buildReplicationPushRequest(c.db, WORKSPACE),
        {
          authenticatedReplicaId: REPLICA_C,
          authenticatedPrincipalId: principalC,
          actor: "agent-c",
          clock: h.authorityClock,
        },
      );
      expect(cResponse.results[0]?.disposition).toBe("applied");
      expect(await getTask(h.authority.db, COMMITMENT_ID, WORKSPACE)).toMatchObject({
        title: "D canonical",
        description: "C pending",
      });
    } finally {
      await Promise.all([h.authority.close(), h.a.close(), h.b.close(), c.close(), d.close()]);
    }
  });

  it("expires a cursor ahead of an authority restored without the required epoch rotation", async () => {
    const h = await bootstrapTwoReplicas();
    try {
      await expect(pullReplication(h.authority.db, {
        workspaceId: WORKSPACE,
        replicaId: REPLICA_A,
        generationId: GENERATION_A,
        authenticatedReplicaId: REPLICA_B,
        cursor: null,
        clock: h.authorityClock,
      })).rejects.toMatchObject({ code: "unauthenticated_origin" });
      const beforeRestore = await pullReplication(h.authority.db, {
        workspaceId: WORKSPACE,
        replicaId: REPLICA_A,
        generationId: GENERATION_A,
        authenticatedReplicaId: REPLICA_A,
        cursor: null,
        clock: h.authorityClock,
      });
      expect(beforeRestore.disposition).toBe("incremental");
      await h.authority.client.execute({
        sql: "UPDATE replication_authority SET current_sequence = 0, updated_at = ? WHERE workspace_id = ?",
        args: [h.authorityClock.now(), WORKSPACE],
      });
      const afterRestore = await pullReplication(h.authority.db, {
        workspaceId: WORKSPACE,
        replicaId: REPLICA_A,
        generationId: GENERATION_A,
        authenticatedReplicaId: REPLICA_A,
        cursor: beforeRestore.nextCursor,
        clock: h.authorityClock,
      });
      expect(afterRestore.disposition).toBe("cursor_expired");
      if (afterRestore.disposition === "cursor_expired") {
        expect(afterRestore.snapshot.coveredSequence).toBe(0);
        await expect(installReplicationSnapshotAndRebase(h.a.db, afterRestore.snapshot, {
          clock: h.aClock,
          actor: "agent-a",
          cursor: afterRestore.nextCursor,
        })).rejects.toThrow("regressed without the mandatory authority epoch rotation");
      }
    } finally {
      await Promise.all([h.authority.close(), h.a.close(), h.b.close()]);
    }
  });

  it("expires pruned cursors and prevents stale resurrection after tombstone compaction", async () => {
    const h = await bootstrapTwoReplicas();
    try {
      h.aClock.set(1);
      const staleCursor = (await acceptReplicationPush(
        h.authority.db,
        await (async () => {
          await queueReplicatedCommitmentDelete(h.a.db, COMMITMENT_ID, {
            workspaceId: WORKSPACE, actor: "agent-a", clock: h.aClock,
          });
          return buildReplicationPushRequest(h.a.db, WORKSPACE);
        })(),
        {
          authenticatedReplicaId: REPLICA_A,
          authenticatedPrincipalId: h.principalA,
          actor: "agent-a",
          clock: h.authorityClock,
        },
      )).cursor;
      expect((await getTask(h.authority.db, COMMITMENT_ID, WORKSPACE))?.deletedAt)
        .toBe(h.authorityClock.now());

      // B still has the live snapshot and authors an edit before seeing delete.
      await queueReplicatedCommitmentUpdate(h.b.db, COMMITMENT_ID, { title: "stale resurrection" }, {
        workspaceId: WORKSPACE, actor: "agent-b", clock: h.bClock,
      });
      h.authorityClock.advance(REPLICATION_RETENTION.activeReplicaMs - 24 * 60 * 60 * 1_000);
      await registerReplicationReplica(h.authority.db, {
        workspaceId: WORKSPACE,
        replicaId: REPLICA_B,
        generationId: GENERATION_B,
        clock: h.authorityClock,
      });
      await registerReplicationReplica(h.authority.db, {
        workspaceId: WORKSPACE,
        replicaId: REPLICA_A,
        generationId: GENERATION_A,
        clock: h.authorityClock,
      });
      h.authorityClock.advance(2 * 24 * 60 * 60 * 1_000);
      await retireReplicatedCommitment(h.authority.db, WORKSPACE, COMMITMENT_ID, h.authorityClock);
      const staleResult = await acceptReplicationPush(
        h.authority.db,
        await buildReplicationPushRequest(h.b.db, WORKSPACE),
        {
          authenticatedReplicaId: REPLICA_B,
          authenticatedPrincipalId: h.principalB,
          actor: "agent-b",
          clock: h.authorityClock,
        },
      );
      expect(staleResult.results[0]).toMatchObject({
        disposition: "conflicted",
        conflict: { reason: "retired_identity", authoritySnapshot: null },
      });
      expect(await getTask(h.authority.db, COMMITMENT_ID, WORKSPACE)).toBeNull();
      expect((await getReplicationSnapshot(h.authority.db, WORKSPACE)).retiredIdentities)
        .toContainEqual(expect.objectContaining({ recordId: COMMITMENT_ID }));

      // Both active replicas acknowledge the current frontier, then age alone
      // (from the injected clock) makes history eligible for pruning.
      const currentA = await pullReplication(h.authority.db, {
        workspaceId: WORKSPACE,
        replicaId: REPLICA_A,
        generationId: GENERATION_A,
        authenticatedReplicaId: REPLICA_A,
        cursor: null,
        clock: h.authorityClock,
      });
      const currentB = await pullReplication(h.authority.db, {
        workspaceId: WORKSPACE,
        replicaId: REPLICA_B,
        generationId: GENERATION_B,
        authenticatedReplicaId: REPLICA_B,
        cursor: null,
        clock: h.authorityClock,
      });
      expect(currentA.disposition).toBe("incremental");
      expect(currentB.disposition).toBe("incremental");
      h.authorityClock.advance(REPLICATION_RETENTION.operationMinimumMs + 1);
      const pruned = await pruneReplicationHistory(h.authority.db, WORKSPACE, h.authorityClock);
      expect(pruned.pruned).toBeGreaterThan(0);

      const expired = await pullReplication(h.authority.db, {
        workspaceId: WORKSPACE,
        replicaId: REPLICA_A,
        generationId: GENERATION_A,
        authenticatedReplicaId: REPLICA_A,
        cursor: staleCursor,
        clock: h.authorityClock,
      });
      expect(expired.disposition).toBe("cursor_expired");
      if (expired.disposition === "cursor_expired") {
        expect(expired.snapshot.snapshotDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
        expect(expired.snapshot.coveredSequence).toBeGreaterThanOrEqual(expired.minimumRetainedSequence);
      }
    } finally {
      await Promise.all([h.authority.close(), h.a.close(), h.b.close()]);
    }
  });
});
