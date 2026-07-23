/**
 * Zod validator tests — ensure the type layer catches invalid input
 * before it reaches the DB. The service layer parses every input
 * through these schemas ; if a violation gets past them, we have a
 * silent corruption channel.
 */

import { describe, expect, it } from "bun:test";
import {
  Area,
  AreaInsert,
  Goal,
  GoalInsert,
  GoalStatus,
  Project,
  ProjectInsert,
  ProjectStatus,
  Task,
  TaskInsert,
  TaskStatus,
  Event,
  EventInsert,
  EntityType,
  TaskUpdate,
  TaskDependency,
  TaskDependencyInsert,
  DEPENDENCY_TYPES,
  RECURRENCE_UNITS,
  RECURRENCE_ANCHORS,
  RecurrenceUnit,
  RecurrenceAnchor,
  UuidV7,
  Slug,
  Importance,
  Priority,
  WaitCondition,
  WaitConditionInsert,
  Observation,
  ObservationInsert,
  Reconciliation,
  IdempotencyRecord,
  shortId,
  uuidv7,
} from "../src/index.js";

const VALID_UUID = "01900000-0000-7000-8000-000000000000";

describe("UuidV7 schema", () => {
  it("accepts canonical UUIDv7", () => {
    expect(() => UuidV7.parse(VALID_UUID)).not.toThrow();
  });

  it("rejects UUIDv4", () => {
    expect(() => UuidV7.parse("01900000-0000-4000-8000-000000000000")).toThrow();
  });

  it("rejects non-UUID strings", () => {
    expect(() => UuidV7.parse("not-a-uuid")).toThrow();
    expect(() => UuidV7.parse("")).toThrow();
  });
});

describe("shortId", () => {
  it("includes the full UUIDv7 millisecond timestamp and entropy prefix", () => {
    const a = "019e82f9-7e06-7000-8000-000000000001";
    const b = "019e82f9-7e07-7000-8000-000000000002";
    expect(shortId(a)).toBe("019e82f9-7e06-7000");
    expect(shortId(b)).toBe("019e82f9-7e07-7000");
    expect(shortId(a)).not.toBe(shortId(b));
  });
});

describe("Slug schema", () => {
  it("accepts kebab-case lower-alphanumeric", () => {
    expect(Slug.parse("kami")).toBe("kami");
    expect(Slug.parse("health-body")).toBe("health-body");
    expect(Slug.parse("a1")).toBe("a1");
  });

  it("rejects uppercase, underscores, leading hyphens", () => {
    expect(() => Slug.parse("Kami")).toThrow();
    expect(() => Slug.parse("health_body")).toThrow();
    expect(() => Slug.parse("-health")).toThrow();
    expect(() => Slug.parse("")).toThrow();
  });

  it("rejects too-long slugs", () => {
    expect(() => Slug.parse("a".repeat(65))).toThrow();
  });
});

describe("Importance / Priority schemas", () => {
  it("accept integers 1-5", () => {
    for (const n of [1, 2, 3, 4, 5]) {
      expect(Importance.parse(n)).toBe(n);
      expect(Priority.parse(n)).toBe(n);
    }
  });

  it("reject out-of-range or non-integer values", () => {
    expect(() => Importance.parse(0)).toThrow();
    expect(() => Importance.parse(6)).toThrow();
    expect(() => Importance.parse(3.5)).toThrow();
    expect(() => Importance.parse(-1)).toThrow();
    expect(() => Priority.parse(0)).toThrow();
  });
});

describe("IdempotencyRecord schema", () => {
  const base = {
    tenantId: "workspace:alpha",
    callerScope: "principal:agent-1",
    operation: "task.update",
    key: "request-1",
    digestVersion: "tasq.jcs.sha256.v1" as const,
    requestDigest: `sha256:${"a".repeat(64)}`,
    resultType: "task",
    resultId: VALID_UUID,
    resultStatus: "open",
    resultRevision: 2,
    eventSequence: 3,
    createdAt: 1_000,
  };

  it("requires coherent expiry for standard and durable retention", () => {
    expect(IdempotencyRecord.parse({
      ...base,
      retentionClass: "standard",
      expiresAt: 2_000,
    }).expiresAt).toBe(2_000);
    expect(IdempotencyRecord.parse({
      ...base,
      retentionClass: "durable",
      expiresAt: null,
    }).expiresAt).toBeNull();
    expect(() => IdempotencyRecord.parse({
      ...base,
      retentionClass: "standard",
      expiresAt: null,
    })).toThrow(/future expiry/);
    expect(() => IdempotencyRecord.parse({
      ...base,
      retentionClass: "durable",
      expiresAt: 2_000,
    })).toThrow(/do not expire/);
  });

  it("rejects unversioned digests and overlong workspace identities", () => {
    expect(() => IdempotencyRecord.parse({
      ...base,
      requestDigest: "a".repeat(64),
      retentionClass: "standard",
      expiresAt: 2_000,
    })).toThrow();
    expect(() => IdempotencyRecord.parse({
      ...base,
      tenantId: "w".repeat(501),
      retentionClass: "standard",
      expiresAt: 2_000,
    })).toThrow();
  });
});

describe("Enum schemas", () => {
  it("TaskStatus accepts canonical values, rejects others", () => {
    for (const s of ["open", "in_progress", "blocked", "done", "cancelled"]) {
      expect(TaskStatus.parse(s)).toBe(s);
    }
    expect(() => TaskStatus.parse("doing")).toThrow();
    expect(() => TaskStatus.parse("DONE")).toThrow();
  });

  it("GoalStatus accepts active/paused/done/abandoned", () => {
    for (const s of ["active", "paused", "done", "abandoned"]) {
      expect(GoalStatus.parse(s)).toBe(s);
    }
    expect(() => GoalStatus.parse("blocked")).toThrow();
  });

  it("ProjectStatus accepts active/blocked/waiting/done/cancelled", () => {
    for (const s of ["active", "blocked", "waiting", "done", "cancelled"]) {
      expect(ProjectStatus.parse(s)).toBe(s);
    }
    expect(() => ProjectStatus.parse("paused")).toThrow();
  });

  it("EntityType accepts the 4 first-class entities", () => {
    for (const t of ["area", "goal", "project", "task"]) {
      expect(EntityType.parse(t)).toBe(t);
    }
    expect(() => EntityType.parse("event")).toThrow();
  });
});

describe("AreaInsert defaults", () => {
  it("fills tenantId, importance, metadata when omitted", () => {
    const parsed = AreaInsert.parse({ name: "Body", slug: "body" });
    expect(parsed.tenantId).toBe("gwendall");
    expect(parsed.importance).toBe(3);
    expect(parsed.metadata).toEqual({});
    expect(parsed.cadenceTarget).toBeNull();
    expect(parsed.description).toBeNull();
  });

  it("requires name and slug", () => {
    expect(() => AreaInsert.parse({ slug: "body" })).toThrow();
    expect(() => AreaInsert.parse({ name: "Body" })).toThrow();
  });

  it("validates importance bounds", () => {
    expect(() => AreaInsert.parse({ name: "X", slug: "x", importance: 6 })).toThrow();
    expect(() => AreaInsert.parse({ name: "X", slug: "x", importance: 0 })).toThrow();
  });
});

describe("TaskInsert defaults", () => {
  it("fills status=open + scalar nullable defaults, leaves hierarchy fields undefined", () => {
    const parsed = TaskInsert.parse({ title: "Test" });
    expect(parsed.status).toBe("open");
    expect(parsed.tenantId).toBe("gwendall");
    expect(parsed.nextAction).toBeNull();
    expect(parsed.priority).toBeNull();
    expect(parsed.estimatedMinutes).toBeNull();
    expect(parsed.scheduledAt).toBeNull();
    expect(parsed.dueAt).toBeNull();
    expect(parsed.metadata).toEqual({});
  });

  it("leaves hierarchy fields (projectId/goalId/areaId/parentTaskId) undefined when omitted, so createTask can distinguish 'inherit' from 'detach'", () => {
    const parsed = TaskInsert.parse({ title: "Test" });
    expect(parsed.projectId).toBeUndefined();
    expect(parsed.goalId).toBeUndefined();
    expect(parsed.areaId).toBeUndefined();
    expect(parsed.parentTaskId).toBeUndefined();
  });

  it("preserves explicit null on hierarchy fields", () => {
    const parsed = TaskInsert.parse({ title: "Test", projectId: null, areaId: null });
    expect(parsed.projectId).toBeNull();
    expect(parsed.areaId).toBeNull();
  });

  it("requires title", () => {
    expect(() => TaskInsert.parse({})).toThrow();
    expect(() => TaskInsert.parse({ title: "" })).toThrow();
  });

  it("validates priority bounds", () => {
    expect(() => TaskInsert.parse({ title: "X", priority: 0 })).toThrow();
    expect(() => TaskInsert.parse({ title: "X", priority: 6 })).toThrow();
    expect(TaskInsert.parse({ title: "X", priority: 5 }).priority).toBe(5);
  });

  it("rejects negative estimatedMinutes", () => {
    expect(() => TaskInsert.parse({ title: "X", estimatedMinutes: -5 })).toThrow();
    expect(() => TaskInsert.parse({ title: "X", estimatedMinutes: 0 })).toThrow();
  });

  it("optional id must be valid UUIDv7 when provided", () => {
    expect(() =>
      TaskInsert.parse({ title: "X", id: "01900000-0000-4000-8000-000000000000" }),
    ).toThrow();
    expect(() => TaskInsert.parse({ title: "X", id: uuidv7() })).not.toThrow();
  });
});

describe("Task recurrence schema (SPEC §6.4-H)", () => {
  it("RecurrenceUnit / RecurrenceAnchor enums accept their values, reject others", () => {
    for (const u of RECURRENCE_UNITS) expect(RecurrenceUnit.parse(u)).toBe(u);
    expect(() => RecurrenceUnit.parse("hourly")).toThrow();
    for (const a of RECURRENCE_ANCHORS) expect(RecurrenceAnchor.parse(a)).toBe(a);
    expect(() => RecurrenceAnchor.parse("start")).toThrow();
  });

  it("TaskInsert defaults: recurrence=null, interval=1, anchor='due', no streak/lastDoneAt key", () => {
    const parsed = TaskInsert.parse({ title: "T" });
    expect(parsed.recurrence).toBeNull();
    expect(parsed.recurrenceInterval).toBe(1);
    expect(parsed.recurrenceAnchor).toBe("due");
    // streak / lastDoneAt are engine-owned — omitted from the insert shape.
    expect("streak" in parsed).toBe(false);
    expect("lastDoneAt" in parsed).toBe(false);
    expect(parsed.recurrenceParentId).toBeUndefined();
  });

  it("TaskInsert round-trips an explicit recurring config", () => {
    const parsed = TaskInsert.parse({
      title: "rent",
      recurrence: "weekly",
      recurrenceInterval: 2,
      recurrenceAnchor: "scheduled",
    });
    expect(parsed.recurrence).toBe("weekly");
    expect(parsed.recurrenceInterval).toBe(2);
    expect(parsed.recurrenceAnchor).toBe("scheduled");
  });

  it("rejects invalid recurrence unit, invalid anchor, interval=0", () => {
    expect(() => TaskInsert.parse({ title: "X", recurrence: "hourly" })).toThrow();
    expect(() => TaskInsert.parse({ title: "X", recurrenceAnchor: "now" })).toThrow();
    expect(() => TaskInsert.parse({ title: "X", recurrenceInterval: 0 })).toThrow();
    expect(() => TaskInsert.parse({ title: "X", recurrenceInterval: -1 })).toThrow();
  });

  it("full Task parses with all recurrence fields populated", () => {
    const t = Task.parse({
      id: VALID_UUID,
      tenantId: "gwendall",
      projectId: null,
      goalId: null,
      areaId: null,
      parentTaskId: null,
      title: "chain instance",
      description: null,
      nextAction: null,
      successCriteria: null,
      completionMode: "assertion",
      validationRequired: false,
      status: "open",
      priority: null,
      estimatedMinutes: null,
      scheduledAt: null,
      dueAt: 1_700_000_000_000,
      startedAt: null,
      completedAt: null,
      recurrence: "monthly",
      recurrenceInterval: 1,
      recurrenceAnchor: "due",
      lastDoneAt: 1_699_000_000_000,
      streak: 3,
      recurrenceParentId: VALID_UUID,
      metadata: {},
      revision: 1,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      deletedAt: null,
    });
    expect(t.recurrence).toBe("monthly");
    expect(t.streak).toBe(3);
    expect(t.recurrenceParentId).toBe(VALID_UUID);
  });

  it("TaskUpdate allows recurrence fields but NOT streak/lastDoneAt/recurrenceParentId (engine-owned)", () => {
    const u = TaskUpdate.parse({
      recurrence: "daily",
      recurrenceInterval: 3,
      recurrenceAnchor: "completion",
    });
    expect(u.recurrence).toBe("daily");
    expect(u.recurrenceInterval).toBe(3);
    expect(u.recurrenceAnchor).toBe("completion");
    // Engine-owned fields are stripped (not in the pick), never written via update.
    const sneaky = TaskUpdate.parse({ streak: 99, lastDoneAt: 1, recurrenceParentId: VALID_UUID });
    expect("streak" in sneaky).toBe(false);
    expect("lastDoneAt" in sneaky).toBe(false);
    expect("recurrenceParentId" in sneaky).toBe(false);
  });
});

describe("GoalInsert defaults", () => {
  it("fills status=active, importance=3, defaults", () => {
    const parsed = GoalInsert.parse({ areaId: VALID_UUID, title: "G" });
    expect(parsed.status).toBe("active");
    expect(parsed.importance).toBe(3);
    expect(parsed.horizon).toBeNull();
    expect(parsed.targetDate).toBeNull();
  });

  it("requires areaId + title", () => {
    expect(() => GoalInsert.parse({ title: "G" })).toThrow();
    expect(() => GoalInsert.parse({ areaId: VALID_UUID })).toThrow();
  });

  it("areaId must be UUIDv7", () => {
    expect(() => GoalInsert.parse({ areaId: "not-uuid", title: "G" })).toThrow();
  });
});

describe("ProjectInsert defaults", () => {
  it("status=active, nullable refs default to null", () => {
    const p = ProjectInsert.parse({ title: "P" });
    expect(p.status).toBe("active");
    expect(p.goalId).toBeNull();
    expect(p.areaId).toBeNull();
  });
});

describe("EventInsert", () => {
  it("requires entityType, entityId, eventType", () => {
    expect(() =>
      EventInsert.parse({
        entityType: "task",
        entityId: VALID_UUID,
        eventType: "created",
      }),
    ).not.toThrow();
    expect(() =>
      EventInsert.parse({ entityType: "task", entityId: VALID_UUID }),
    ).toThrow();
  });

  it("default actor=system, default payload={}", () => {
    const e = EventInsert.parse({
      entityType: "task",
      entityId: VALID_UUID,
      eventType: "created",
    });
    expect(e.actor).toBe("system");
    expect(e.payload).toEqual({});
  });

  it("entityType must be in the 4-entity enum", () => {
    expect(() =>
      EventInsert.parse({
        entityType: "comment",
        entityId: VALID_UUID,
        eventType: "x",
      }),
    ).toThrow();
  });

  it("event payload accepts before/after/note/reason/source", () => {
    const e = EventInsert.parse({
      entityType: "task",
      entityId: VALID_UUID,
      eventType: "completed",
      payload: {
        before: { status: "open" },
        after: { status: "done" },
        note: "shipped via Mercury wire",
        source: "watcher:mercury",
      },
    });
    expect(e.payload.note).toBe("shipped via Mercury wire");
    expect(e.payload.source).toBe("watcher:mercury");
    expect(e.payload.before).toEqual({ status: "open" });
    expect(e.payload.after).toEqual({ status: "done" });
  });

  it("event payload rejects unknown extra keys are allowed (loose) but typed values enforced", () => {
    // Zod default = strip unknown ; payload schema uses Metadata for before/after
    // which is z.record(z.unknown()), so arbitrary keys are allowed inside.
    const e = EventInsert.parse({
      entityType: "task",
      entityId: VALID_UUID,
      eventType: "x",
      payload: { after: { foo: 1, bar: "two", nested: { x: true } } },
    });
    expect(e.payload.after).toEqual({ foo: 1, bar: "two", nested: { x: true } });
  });
});

const VALID_UUID_2 = "01900000-0000-7000-8000-000000000001";

describe("TaskDependency schema (SPEC §4.5)", () => {
  it("parses a valid edge", () => {
    const edge = TaskDependency.parse({
      id: VALID_UUID,
      tenantId: "gwendall",
      fromTaskId: VALID_UUID,
      toTaskId: VALID_UUID_2,
      type: "blocks",
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      deletedAt: null,
    });
    expect(edge.type).toBe("blocks");
    expect(edge.fromTaskId).toBe(VALID_UUID);
    expect(edge.toTaskId).toBe(VALID_UUID_2);
  });

  it("accepts all three dependency types", () => {
    for (const type of DEPENDENCY_TYPES) {
      const edge = TaskDependencyInsert.parse({
        fromTaskId: VALID_UUID,
        toTaskId: VALID_UUID_2,
        type,
      });
      expect(edge.type).toBe(type);
    }
  });

  it("rejects a type outside the three-value enum", () => {
    expect(() =>
      TaskDependencyInsert.parse({
        fromTaskId: VALID_UUID,
        toTaskId: VALID_UUID_2,
        type: "requires",
      }),
    ).toThrow();
  });

  it("defaults type='blocks' and tenantId='gwendall' on insert", () => {
    const edge = TaskDependencyInsert.parse({
      fromTaskId: VALID_UUID,
      toTaskId: VALID_UUID_2,
    });
    expect(edge.type).toBe("blocks");
    expect(edge.tenantId).toBe("gwendall");
    // id is optional on insert (minted by the service if omitted).
    expect(edge.id).toBeUndefined();
  });

  it("rejects a non-UUID endpoint", () => {
    expect(() =>
      TaskDependencyInsert.parse({
        fromTaskId: "not-a-uuid",
        toTaskId: VALID_UUID_2,
      }),
    ).toThrow();
  });
});

describe("WaitCondition schema", () => {
  it("defaults a typed wait to a neutral waiting condition", () => {
    const value = WaitConditionInsert.parse({
      taskId: VALID_UUID,
      kind: "gmail.thread_reply",
      parameters: { connectorAccount: "gmail:primary", threadId: "thread-1" },
    });
    expect(value).toMatchObject({
      schemaVersion: 1,
      deadlineAt: null,
      fallbackKind: "none",
      fallbackSpec: null,
      fallbackTargetTaskId: null,
      supersedesConditionId: null,
    });
    expect(value.parameters).toEqual({
      connectorAccount: "gmail:primary",
      threadId: "thread-1",
    });
  });

  it("requires an exact fallback shape", () => {
    expect(() =>
      WaitConditionInsert.parse({
        taskId: VALID_UUID,
        kind: "gmail.thread_reply",
        parameters: { connectorAccount: "gmail:primary", threadId: "thread-1" },
        fallbackKind: "activate_task",
      }),
    ).toThrow();
  });

  it("rejects inconsistent terminal fields", () => {
    expect(() =>
      WaitCondition.parse({
        id: VALID_UUID_2,
        tenantId: "gwendall",
        taskId: VALID_UUID,
        kind: "gmail.thread_reply",
        schemaVersion: 1,
        parameters: { connectorAccount: "gmail:primary", threadId: "thread-1" },
        status: "satisfied",
        notBefore: 1_000,
        deadlineAt: null,
        fallbackKind: "none",
        fallbackSpec: null,
        fallbackTargetTaskId: null,
        fallbackResultTaskId: null,
        supersedesConditionId: null,
        satisfiedAt: null,
        satisfiedByObservationId: null,
        expiredAt: null,
        cancelledAt: null,
        cancelReason: null,
        createdAt: 1_000,
        updatedAt: 1_000,
      }),
    ).toThrow(/terminal fields/);
  });
});

describe("Observation schema", () => {
  it("keeps the closed v1 alias while leaving domain canonicalization to extensions", () => {
    const input = ObservationInsert.parse({
      source: "github:work",
      externalEventId: "delivery-1",
      kind: "github.pull_request",
      payload: {
        host: "github.com",
        owner: "kami",
        repository: "robot",
        pullRequestNumber: 42,
        state: "merged",
      },
      occurredAt: 1_000,
    });
    expect(input.kind).toBe("github.pull_request");
    expect(input.schemaVersion).toBe(1);
    expect(input.payload).toEqual({
      host: "github.com",
      owner: "kami",
      repository: "robot",
      pullRequestNumber: 42,
      state: "merged",
    });
  });

  it("requires explicit verification method and raw-content binding", () => {
    expect(() =>
      ObservationInsert.parse({
        source: "gmail:primary",
        externalEventId: "delivery-1",
        kind: "gmail.message",
        payload: {},
        occurredAt: 1_000,
        verificationLevel: "provider_verified",
      }),
    ).toThrow(/verification method/);
    expect(() =>
      ObservationInsert.parse({
        source: "gmail:primary",
        externalEventId: "delivery-1",
        kind: "gmail.message",
        payload: {},
        occurredAt: 1_000,
        rawRef: "vault://message",
      }),
    ).toThrow(/binding digest/);
  });

  it("parses a complete immutable observation record", () => {
    expect(() =>
      Observation.parse({
        id: VALID_UUID_2,
        tenantId: "gwendall",
        source: "gmail:primary",
        externalEventId: "delivery-1",
        kind: "gmail.message",
        schemaVersion: 1,
        subjectRef: '["gmail.message","gmail:primary","thread-1"]',
        payload: {
          connectorAccount: "gmail:primary",
          messageId: "message-1",
          threadId: "thread-1",
          sender: "alice@example.test",
        },
        occurredAt: 1_000,
        recordedAt: 1_100,
        recordedBy: "watcher:gmail",
        verificationLevel: "unverified",
        verificationMethod: null,
        rawRef: null,
        digest: null,
        metadata: {},
      }),
    ).not.toThrow();
  });
});

describe("Reconciliation schema", () => {
  const base = {
    id: VALID_UUID,
    tenantId: "gwendall",
    conditionId: VALID_UUID_2,
    observationId: "01900000-0000-7000-8000-000000000002",
    matcherKind: "gmail.thread_reply" as const,
    matcherVersion: 1,
    reasonCode: "all_typed_checks_matched",
    explanation: "All required typed fields matched exactly.",
    reconciledAt: 1_000,
    reconciledBy: "system",
  };

  it("requires evidence exactly when a match satisfies the condition", () => {
    expect(() =>
      Reconciliation.parse({
        ...base,
        decision: "matched",
        effect: "satisfied",
        evidenceId: "01900000-0000-7000-8000-000000000003",
      }),
    ).not.toThrow();
    expect(() =>
      Reconciliation.parse({
        ...base,
        decision: "matched",
        effect: "satisfied",
        evidenceId: null,
      }),
    ).toThrow(/inconsistent/);
  });

  it("forbids terminal effects for rejected or ambiguous decisions", () => {
    expect(() =>
      Reconciliation.parse({
        ...base,
        decision: "ambiguous",
        effect: "condition_terminal",
        evidenceId: null,
      }),
    ).toThrow(/inconsistent/);
  });
});
