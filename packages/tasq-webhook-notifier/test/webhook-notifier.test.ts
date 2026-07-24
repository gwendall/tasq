import { describe, expect, test } from "bun:test";
import {
  ATTENTION_KINDS,
  createAttentionEnvelope,
  createAttentionWebhookSink,
} from "../src/index.js";

const secret = "a".repeat(32);
const envelope = createAttentionEnvelope({
  workspaceId: "team/acme",
  eventId: "event-1",
  eventSequence: 42,
  kind: "validation_requested",
  recipientRef: "principal:reviewer",
  commitmentId: "commitment-1",
  reasonCode: "independent_review_required",
  summary: "Review the attached completion evidence",
  occurredAt: 1_900_000_000_000,
});

describe("TQ-813 attention webhook", () => {
  test("accepts only the six neutral attention classes and derives stable delivery identity", () => {
    expect(ATTENTION_KINDS).toHaveLength(6);
    expect(createAttentionEnvelope({
      workspaceId: "team/acme",
      eventId: "event-1",
      eventSequence: 42,
      kind: "validation_requested",
      recipientRef: "principal:reviewer",
      commitmentId: "commitment-1",
      reasonCode: "independent_review_required",
      summary: "Review the attached completion evidence",
      occurredAt: 1_900_000_000_000,
    })).toEqual(envelope);
    expect(envelope.deliveryId).toMatch(/^attention:[0-9a-f]{64}$/);
  });

  test("signs one exact bounded envelope and requires an identity-bound acknowledgement", async () => {
    let captured: Request | null = null;
    const sink = createAttentionWebhookSink({
      endpoint: "https://hooks.example/attention",
      keyId: "key-1",
      secret,
      fetch: async (request, init) => {
        captured = new Request(request, init);
        return Response.json({
          contractVersion: "tasq.attention-webhook-ack.v1",
          deliveryId: envelope.deliveryId,
          payloadDigest: envelope.payloadDigest,
          status: "accepted",
          providerMessageId: "message-1",
          acceptedAt: 1_900_000_000_010,
        });
      },
    });
    expect(await sink.deliver(envelope)).toMatchObject({ outcome: "committed" });
    expect(captured!.headers.get("tasq-delivery-id")).toBe(envelope.deliveryId);
    expect(captured!.headers.get("tasq-signature")).toMatch(/^hmac-sha256 key=key-1,signature=/);
  });

  test("classifies explicit backpressure, unknown transport, redirects and forged acks", async () => {
    const result = async (fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) =>
      createAttentionWebhookSink({
        endpoint: "https://hooks.example/attention", keyId: "key-1", secret, fetch,
      }).deliver(envelope);
    expect(await result(async () => new Response("", { status: 503, headers: { "retry-after": "9" } })))
      .toEqual({ outcome: "retry_same_delivery", retryAfterMs: 9_000, reason: "receiver unavailable (503)" });
    expect(await result(async () => { throw new Error("socket reset"); }))
      .toEqual({ outcome: "indeterminate", reason: "socket reset" });
    expect(await result(async () => new Response("", { status: 307, headers: { location: "https://evil.example/" } })))
      .toEqual({ outcome: "failed", reason: "redirects are forbidden" });
    expect(await result(async () => Response.json({
      contractVersion: "tasq.attention-webhook-ack.v1",
      deliveryId: "attention:wrong",
      payloadDigest: envelope.payloadDigest,
      status: "accepted",
      providerMessageId: null,
      acceptedAt: 1,
    }))).toEqual({ outcome: "indeterminate", reason: "acknowledgement identity mismatch" });
  });
});
