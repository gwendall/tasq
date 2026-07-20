import { describe, expect, test } from "bun:test";

type Operation = {
  replica: string;
  generation: string;
  counter: number;
  digest: string;
  recordId: string;
  baseDigest: string | null;
  desiredDigest: string;
  occurredAt: number;
};

type Conflict = {
  id: string;
  incomingOperation: string;
  baseDigest: string | null;
  authorityDigest: string | null;
  incomingDigest: string;
  recordedAt: number;
  reason: "concurrent_mutation" | "retired_identity";
};

type Result =
  | { disposition: "applied" | "equivalent"; sequence: number }
  | { disposition: "conflicted"; sequence: number; conflict: Conflict }
  | { disposition: "identity_corruption" };

const operationId = (operation: Operation): string =>
  `${operation.replica}:${operation.generation}:${operation.counter}`;

/**
 * ADR-003 acceptance oracle retained as a tiny language-neutral model. TQ-405's
 * real multi-SQLite service tests preserve these same black-box outcomes.
 */
class ReferenceAuthority {
  readonly state = new Map<string, string>();
  readonly conflicts = new Map<string, Conflict>();
  readonly retired = new Set<string>();
  readonly seen = new Map<string, { digest: string; result: Result }>();
  readonly highWater = new Map<string, number>();
  sequence = 0;
  minimumRetainedSequence = 0;

  constructor(private readonly now: () => number) {}

  accept(operation: Operation): Result {
    const id = operationId(operation);
    const prior = this.seen.get(id);
    if (prior) {
      return prior.digest === operation.digest
        ? prior.result
        : { disposition: "identity_corruption" };
    }

    const origin = `${operation.replica}:${operation.generation}`;
    if (operation.counter !== (this.highWater.get(origin) ?? 0) + 1) {
      throw new Error(`origin counter gap for ${id}`);
    }

    const current = this.state.get(operation.recordId) ?? null;
    let result: Result;
    if (current === operation.desiredDigest) {
      result = { disposition: "equivalent", sequence: ++this.sequence };
    } else if (!this.retired.has(operation.recordId) && current === operation.baseDigest) {
      this.state.set(operation.recordId, operation.desiredDigest);
      result = { disposition: "applied", sequence: ++this.sequence };
    } else {
      const conflict: Conflict = {
        id: `conflict:${id}`,
        incomingOperation: id,
        baseDigest: operation.baseDigest,
        authorityDigest: current,
        incomingDigest: operation.desiredDigest,
        recordedAt: this.now(),
        reason: this.retired.has(operation.recordId)
          ? "retired_identity"
          : "concurrent_mutation",
      };
      this.conflicts.set(conflict.id, conflict);
      result = { disposition: "conflicted", sequence: ++this.sequence, conflict };
    }

    this.highWater.set(origin, operation.counter);
    this.seen.set(id, { digest: operation.digest, result });
    return result;
  }

  compactTombstone(recordId: string): void {
    this.state.delete(recordId);
    this.retired.add(recordId);
  }

  pull(afterSequence: number):
    | { disposition: "incremental"; afterSequence: number }
    | { disposition: "cursor_expired"; snapshot: { coveredSequence: number; digest: string } } {
    if (afterSequence < this.minimumRetainedSequence) {
      return {
        disposition: "cursor_expired",
        snapshot: {
          coveredSequence: this.sequence,
          digest: `snapshot:${this.sequence}:${[...this.state.entries()].length}:${this.retired.size}`,
        },
      };
    }
    return { disposition: "incremental", afterSequence };
  }
}

describe("TQ-404 replica conflict contract", () => {
  test("two unknown offline agents never lose a same-base edit to wall-clock LWW", () => {
    let authorityNow = 50_000;
    const authority = new ReferenceAuthority(() => authorityNow);
    authority.state.set("commitment:launch", "state:base");

    const earlyArrivalWithFutureClock: Operation = {
      replica: "replica-a",
      generation: "generation-a",
      counter: 1,
      digest: "operation:a",
      recordId: "commitment:launch",
      baseDigest: "state:base",
      desiredDigest: "state:agent-a",
      occurredAt: 9_999_999_999,
    };
    const laterArrivalWithPastClock: Operation = {
      replica: "replica-b",
      generation: "generation-b",
      counter: 1,
      digest: "operation:b",
      recordId: "commitment:launch",
      baseDigest: "state:base",
      desiredDigest: "state:agent-b",
      occurredAt: 1,
    };

    expect(authority.accept(earlyArrivalWithFutureClock)).toEqual({
      disposition: "applied",
      sequence: 1,
    });
    const conflict = authority.accept(laterArrivalWithPastClock);
    expect(conflict).toEqual({
      disposition: "conflicted",
      sequence: 2,
      conflict: {
        id: "conflict:replica-b:generation-b:1",
        incomingOperation: "replica-b:generation-b:1",
        baseDigest: "state:base",
        authorityDigest: "state:agent-a",
        incomingDigest: "state:agent-b",
        recordedAt: 50_000,
        reason: "concurrent_mutation",
      },
    });
    expect(authority.state.get("commitment:launch")).toBe("state:agent-a");
    expect(authority.conflicts.get("conflict:replica-b:generation-b:1"))
      .toEqual((conflict as Extract<Result, { disposition: "conflicted" }>).conflict);

    authorityNow = 99_000;
    expect(authority.accept(laterArrivalWithPastClock)).toEqual(conflict);
    expect(authority.accept({ ...laterArrivalWithPastClock, digest: "forged" }))
      .toEqual({ disposition: "identity_corruption" });
    expect(authority.sequence).toBe(2);
  });

  test("compacted tombstones retain identity and reject stale resurrection", () => {
    const authority = new ReferenceAuthority(() => 100_000);
    authority.state.set("commitment:deleted", "state:live");

    expect(authority.accept({
      replica: "replica-a",
      generation: "generation-a",
      counter: 1,
      digest: "operation:delete",
      recordId: "commitment:deleted",
      baseDigest: "state:live",
      desiredDigest: "state:tombstone",
      occurredAt: 10,
    }).disposition).toBe("applied");

    authority.compactTombstone("commitment:deleted");
    const staleCreate = authority.accept({
      replica: "replica-b",
      generation: "generation-b",
      counter: 1,
      digest: "operation:stale-create",
      recordId: "commitment:deleted",
      baseDigest: null,
      desiredDigest: "state:resurrected",
      occurredAt: 20,
    });

    expect(staleCreate.disposition).toBe("conflicted");
    expect((staleCreate as Extract<Result, { disposition: "conflicted" }>).conflict.reason)
      .toBe("retired_identity");
    expect(authority.state.has("commitment:deleted")).toBe(false);
    expect(authority.retired.has("commitment:deleted")).toBe(true);
  });

  test("an expired cursor returns a verified snapshot boundary, never a partial delta", () => {
    const authority = new ReferenceAuthority(() => 1_000);
    authority.state.set("commitment:one", "state:one");
    authority.sequence = 42;
    authority.minimumRetainedSequence = 30;

    expect(authority.pull(29)).toEqual({
      disposition: "cursor_expired",
      snapshot: { coveredSequence: 42, digest: "snapshot:42:1:0" },
    });
    expect(authority.pull(30)).toEqual({
      disposition: "incremental",
      afterSequence: 30,
    });
  });
});
