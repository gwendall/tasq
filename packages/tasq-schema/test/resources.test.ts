import { describe, expect, it } from "bun:test";
import {
  RESOURCE_KEY_MAX_BYTES,
  ResourceEvent,
  ResourceKey,
  ResourceLease,
  ResourceLeaseOperation,
  ResourceProblem,
} from "../src/index.js";

const id = "01900000-0000-7000-8000-000000000001";

describe("generic resource contracts", () => {
  it("accepts opaque provider-neutral keys and enforces canonical bounded identity", () => {
    expect(ResourceKey.parse("robotics/arm:left/toolhead")).toBe("robotics/arm:left/toolhead");
    expect(ResourceKey.parse("déploiement/équipe-a")).toBe("déploiement/équipe-a");
    expect(ResourceKey.parse("x".repeat(RESOURCE_KEY_MAX_BYTES))).toHaveLength(RESOURCE_KEY_MAX_BYTES);
    expect(() => ResourceKey.parse(` ${"x"}`)).toThrow();
    expect(() => ResourceKey.parse("line\nbreak")).toThrow();
    expect(() => ResourceKey.parse("e\u0301")).toThrow(/NFC/);
    expect(() => ResourceKey.parse("é".repeat(257))).toThrow(/512/);
  });

  it("freezes lease, event, operation and typed-problem envelopes", () => {
    const lease = ResourceLease.parse({
      id,
      workspaceId: "robotics/team-a",
      resourceKey: "arm:left",
      holderActor: "agent:planner",
      holderPrincipalId: "urn:agent:planner",
      revision: 1,
      fence: 1,
      acquiredAt: 1_000,
      heartbeatAt: 1_000,
      expiresAt: 2_000,
      releasedAt: null,
      releaseReason: null,
      metadata: {},
      createdAt: 1_000,
      updatedAt: 1_000,
    });
    expect(ResourceLeaseOperation.parse({
      contractVersion: "tasq.resource-operation.v1",
      disposition: "acquired",
      observedAt: 1_000,
      lease,
      eventCursor: { afterSequence: 1 },
    }).lease.fence).toBe(1);
    expect(ResourceEvent.parse({
      sequence: 1,
      id,
      workspaceId: "robotics/team-a",
      resourceKey: "arm:left",
      leaseId: id,
      actor: "agent:planner",
      principalId: "urn:agent:planner",
      eventType: "resource_lease_acquired",
      payload: {},
      createdAt: 1_000,
    }).sequence).toBe(1);
    expect(ResourceProblem.parse({
      contractVersion: "tasq.resource-problem.v1",
      status: "error",
      code: "contended",
      message: "held",
      retryable: true,
      workspaceId: "robotics/team-a",
      resourceKey: "arm:left",
      currentLease: { status: "active", observedAt: 1_000, lease },
      nextActions: [{
        kind: "wait_until",
        description: "Retry after expiry.",
        notBefore: 2_000,
      }],
    }).currentLease?.lease.holderActor).toBe("agent:planner");
  });
});
