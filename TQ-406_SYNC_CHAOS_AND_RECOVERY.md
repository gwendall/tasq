# TQ-406 — Sync chaos and recovery

**Status:** Done

**Depends on:** TQ-402, TQ-403, TQ-405

**Result:** the M4 crash, divergence, retention and restore gate is executable

## Outcome

Tasq now survives the failures that matter after a write leaves process
memory. Separate worker processes are killed with `SIGKILL` immediately after
each externally visible durable boundary. Replacement processes reopen the
SQLite files and judge only persisted state.

The proof covers both authority-coordinated replication and the local delivery
outbox. It does not pretend a process close is a crash, and it does not use
device timestamps to decide order, expiry or recovery.

## First-principles fault model

A mutation crosses four independent truths:

1. the disconnected replica commits its domain row and outgoing operation;
2. the authority commits an accepted result, but the response can disappear;
3. the replica commits the acknowledgement, but that response can disappear;
4. a verified canonical snapshot commits locally, including any pending rebase.

Delivery adds four more boundaries:

1. an authoritative event and its delivery intent commit atomically;
2. a drainer lease commits before external work;
3. the external sink commits by immutable event identity before local ack;
4. the delivered acknowledgement then commits locally.

If a restart cannot reconstruct the correct next action from durable state at
any one of these boundaries, the protocol is incomplete.

## Executable matrix

`packages/tasq-evals/sync-chaos-recovery.test.ts` proves:

| Failure | Durable result after restart |
|---|---|
| Kill after local operation commit | commitment and pending operation both exist |
| Kill after authority accept commit | retry returns the exact prior result and does not advance sequence |
| Kill after local ack commit | pending queue stays empty; exact duplicate ack succeeds |
| Operation chain arrives tail-first | typed `origin_gap`; authority state and sequence remain unchanged |
| Complete request is duplicated | every dot is deduplicated and the response is identical |
| Two replicas edit one old base offline | first accepted base wins by authority order; the loser remains a visible three-variant conflict |
| Device clocks are inverted | client time has no influence on authority order or conflict classification |
| Injected retention boundary passes | acknowledged history prunes and an old cursor returns `cursor_expired` plus a verified snapshot |
| Kill after snapshot install | reopened replica contains canonical records, cursor state and conflicts |
| Authority backup is older than a client cursor | same-epoch regression is detected and refused |
| Kill after authority recovery commit | exact retry recovers the same new epoch and durable recovery receipt |
| Old client pushes after failover | old epoch is fenced out with `authority_epoch_mismatch` |
| Fresh machine joins recovered authority | new generation installs the verified snapshot and advances the new lineage |
| Kill after outbox intent/lease/external-effect/ack commits | replacement respects lease expiry, sink receipt exists once, delivery remains terminal |

## Findings fixed

### Duplicate acknowledgement was not idempotent

`acknowledgeReplicationPush` previously rejected an exact repeated response
after its first acknowledgement had committed. It now accepts only an exact
match of dot, digest, disposition and authority sequence. Any changed response
fails as `identity_corruption`.

### Restore required an epoch rotation but exposed no safe primitive

`recoverReplicationAuthority` now requires the complete expected old identity,
the exact restored sequence, a distinct caller-supplied new epoch, a reason and
an injected clock. In one operational transaction it:

- rotates the authority epoch;
- marks every pre-restore generation stale;
- builds the rooted recovery snapshot;
- records `replication_authority_recovery` with both epochs, restored frontier,
  snapshot digest, reason and injected recovery time.

An exact retry is idempotent only while that recovered frontier is unchanged.
This handles response loss without allowing a later recovery to masquerade as
the original operation.

### Stale replicas could self-reactivate through pull

A stale or retention-expired generation now receives typed `replica_stale`.
It cannot turn itself active merely by polling. Recovery uses a verified
snapshot and a newly registered generation, as ADR-003 requires.

## Clock discipline

All mutation, lease, retention and recovery timestamps come from explicit
`Clock` instances. The crash worker rejects invalid injected values and a
static assertion forbids raw wall-clock sources. Process watchdog/test timeout
mechanisms never participate in a Tasq decision.

## Recovery procedure

The supported authority-disaster sequence is deliberately explicit:

1. verify the SQLite backup with `verifyDatabaseFile`/`tasq doctor`;
2. inspect and confirm its authority identity and sequence;
3. call `recoverReplicationAuthority` with those exact preconditions, a fresh
   epoch, reason and host clock;
4. retain the returned recovery receipt and snapshot digest;
5. register a fresh replica generation and install a newly fetched verified
   snapshot;
6. never replay an old-epoch operation into the recovered lineage.

Tasq still has no destructive `tasq restore` command. Copying a verified
snapshot into place remains an operator action, not an autonomous-agent tool.

## Evidence

Run from `products/tasq`:

```bash
bun test packages/tasq-service/test/replication.test.ts \
  packages/tasq-evals/sync-chaos-recovery.test.ts
```

The service suite retains deterministic transaction/state-machine coverage;
the eval adds real process death and independent SQLite reopenings.

## Honest limits

- Sync transport authentication is still an adapter responsibility under
  ADR-004; replica IDs and digests are not credentials.
- This is authority-coordinated sync, not symmetric peer-to-peer consensus.
- External sinks must deduplicate by immutable event/effect identity. Tasq can
  preserve retry truth but cannot make an arbitrary provider transactional.
- Recovery intentionally rolls back work newer than the selected backup. Old
  clients detect the regression; Tasq does not invent lost operations.
