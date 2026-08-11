import { describe, expect, test } from "bun:test";
import {
  compareAttentionCohorts,
  createAttentionWebhookSink,
  createInputRequiredAttentionRequest,
  defineAttentionPolicy,
  deliverAttentionPlan,
  measureAttentionCohort,
  planAttention,
} from "../src/index.js";

const secret = "b".repeat(32);
const base = 1_900_000_000_000;
const contextDigest = `sha256:${"c".repeat(64)}`;

function request(index: number, requestedAt = base) {
  return createInputRequiredAttentionRequest({
    workspaceId: "team/acme",
    eventId: `event-${index}`,
    eventSequence: index,
    recipientRef: "principal:operator",
    commitmentId: `commitment-${Math.ceil(index / 2)}`,
    attemptId: `attempt-${index}`,
    reasonCode: "runtime_input_required",
    summary: `Choose an exact response for attempt ${index}`,
    decisionContextDigest: contextDigest,
    requestedAt,
  });
}

function policy(overrides: Record<string, unknown> = {}) {
  return defineAttentionPolicy({
    recipientRef: "principal:operator",
    maximumBatchItems: 25,
    maximumBatchWaitMs: 5_000,
    ...overrides,
  });
}

describe("TQ-620 bounded human attention", () => {
  test("batches stable input-required requests without dropping decision context", () => {
    const requests = [request(2, base + 1), request(1, base)];
    expect(planAttention(requests, policy(), base + 4_999)).toMatchObject({
      outcome: "deferred",
      reason: "batch_window",
      pendingRequestIds: [request(1, base).requestId, request(2, base + 1).requestId],
      nextEligibleAt: base + 5_000,
    });
    const first = planAttention(requests, policy(), base + 5_000);
    const replay = planAttention(requests, policy(), base + 9_000);
    expect(first).toMatchObject({ outcome: "ready", batches: [{ requests: [
      { requestId: request(1, base).requestId, decisionContextDigest: contextDigest },
      { requestId: request(2, base + 1).requestId, decisionContextDigest: contextDigest },
    ] }] });
    if (first.outcome !== "ready" || replay.outcome !== "ready") throw new Error("expected ready plans");
    expect(first.batches[0]!.deliveryId).toBe(replay.batches[0]!.deliveryId);
    expect(first.batches[0]!.payloadDigest).toBe(replay.batches[0]!.payloadDigest);
  });

  test("honours chained half-open DND windows before fullness or response deadlines", async () => {
    let networkCalls = 0;
    const dndPolicy = policy({
      maximumBatchItems: 1,
      doNotDisturbWindows: [
        { startsAt: base - 1_000, endsAt: base + 5_000, sourceRef: "calendar:quiet-1" },
        { startsAt: base + 4_000, endsAt: base + 9_000, sourceRef: "calendar:quiet-2" },
      ],
    });
    const urgent = createInputRequiredAttentionRequest({
      workspaceId: "team/acme",
      eventId: "event-1",
      eventSequence: 1,
      recipientRef: "principal:operator",
      commitmentId: "commitment-1",
      attemptId: "attempt-1",
      reasonCode: "runtime_input_required",
      summary: "Choose an exact response for attempt 1",
      decisionContextDigest: contextDigest,
      requestedAt: base,
      respondBy: base,
    });
    const plan = planAttention([urgent], dndPolicy, base);
    expect(plan).toMatchObject({
      outcome: "deferred", reason: "do_not_disturb", nextEligibleAt: base + 9_000,
    });
    const sink = createAttentionWebhookSink({
      endpoint: "https://hooks.example/attention", keyId: "key-1", secret,
      fetch: async () => {
        networkCalls += 1;
        throw new Error("must not be called during DND");
      },
    });
    expect(await deliverAttentionPlan(plan, sink)).toEqual({
      outcome: "not_delivered", reason: "do_not_disturb", nextEligibleAt: base + 9_000,
    });
    expect(networkCalls).toBe(0);
    expect(planAttention([urgent], dndPolicy, base + 9_000).outcome).toBe("ready");
  });

  test("signs each bounded batch and stops after an indeterminate partial delivery", async () => {
    const requests = Array.from({ length: 3 }, (_, index) => request(index + 1));
    const plan = planAttention(requests, policy({ maximumBatchItems: 2, maximumBatchWaitMs: 0 }), base);
    if (plan.outcome !== "ready") throw new Error("expected ready plan");
    expect(plan.batches).toHaveLength(2);
    let call = 0;
    const contracts: string[] = [];
    const sink = createAttentionWebhookSink({
      endpoint: "https://hooks.example/attention", keyId: "key-1", secret,
      fetch: async (input, init) => {
        call += 1;
        const captured = new Request(input, init);
        contracts.push(captured.headers.get("tasq-contract")!);
        if (call === 2) throw new Error("socket reset");
        const body = await captured.json() as { deliveryId: string; payloadDigest: string };
        return Response.json({
          contractVersion: "tasq.attention-webhook-ack.v1",
          deliveryId: body.deliveryId,
          payloadDigest: body.payloadDigest,
          status: "accepted",
          providerMessageId: `message-${call}`,
          acceptedAt: base + call,
        });
      },
    });
    expect(await deliverAttentionPlan(plan, sink)).toMatchObject({
      outcome: "partially_delivered",
      results: [{ outcome: "committed" }, { outcome: "indeterminate", reason: "socket reset" }],
    });
    expect(contracts).toEqual(["tasq.attention-batch.v1", "tasq.attention-batch.v1"]);
  });

  test("measures fewer solicitations only against externally assessed decision quality", () => {
    const workUnits = [
      { id: "work-1", decisionQualityMicros: 900_000 },
      { id: "work-2", decisionQualityMicros: 800_000 },
    ];
    const requests = [
      { requestId: "request-1", workUnitId: "work-1" },
      { requestId: "request-2", workUnitId: "work-2" },
    ];
    const baseline = measureAttentionCohort({
      workUnits, requests,
      deliveries: [
        { deliveryId: "delivery-1", requestIds: ["request-1"] },
        { deliveryId: "delivery-2", requestIds: ["request-2"] },
      ],
    });
    const candidate = measureAttentionCohort({
      workUnits, requests,
      deliveries: [{ deliveryId: "batch-1", requestIds: ["request-1", "request-2"] }],
    });
    expect(compareAttentionCohorts(baseline, candidate)).toMatchObject({
      solicitationsReduced: true,
      solicitationReductionMicros: 500_000,
      coverageComparable: true,
      qualityComparable: true,
      decisionQualityRetained: true,
      baseline: { meanDecisionQualityMicros: 850_000 },
      candidate: { meanDecisionQualityMicros: 850_000 },
    });
    const unrated = measureAttentionCohort({
      workUnits: workUnits.map((unit) => ({ ...unit, decisionQualityMicros: null })),
      requests, deliveries: [{ deliveryId: "batch-1", requestIds: ["request-1", "request-2"] }],
    });
    expect(compareAttentionCohorts(baseline, unrated)).toMatchObject({
      qualityComparable: false, decisionQualityRetained: false,
    });
  });
});
