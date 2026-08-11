import { createHash, createHmac } from "node:crypto";
import { canonicalizeEffectJson } from "@tasq-run/schema";
import { z } from "zod";

export const ATTENTION_WEBHOOK_CONTRACT_VERSION = "tasq.attention-webhook.v1" as const;
export const ATTENTION_KINDS = [
  "assignment",
  "blocked",
  "authority_expiring",
  "recovery_required",
  "validation_requested",
  "completion_challenged",
] as const;

const AttentionInput = z.object({
  workspaceId: z.string().min(1).max(200),
  eventId: z.string().min(1).max(500),
  eventSequence: z.number().int().positive(),
  kind: z.enum(ATTENTION_KINDS),
  recipientRef: z.string().min(1).max(500),
  commitmentId: z.string().min(1).max(500).nullable().default(null),
  reasonCode: z.string().min(1).max(120),
  summary: z.string().min(1).max(2_000),
  occurredAt: z.number().int().nonnegative(),
}).strict();
export type AttentionInput = z.input<typeof AttentionInput>;

export interface AttentionEnvelope {
  contractVersion: typeof ATTENTION_WEBHOOK_CONTRACT_VERSION;
  deliveryId: string;
  workspaceId: string;
  eventId: string;
  eventSequence: number;
  kind: typeof ATTENTION_KINDS[number];
  recipientRef: string;
  commitmentId: string | null;
  reasonCode: string;
  summary: string;
  occurredAt: number;
  payloadDigest: string;
}

export interface AttentionBatchLikeEnvelope {
  contractVersion: "tasq.attention-batch.v1";
  deliveryId: string;
  payloadDigest: string;
}

export type DeliverableAttentionEnvelope = AttentionEnvelope | AttentionBatchLikeEnvelope;

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalizeEffectJson(value as never)).digest("hex")}`;
}

export function createAttentionEnvelope(input: AttentionInput): Readonly<AttentionEnvelope> {
  const parsed = AttentionInput.parse(input);
  const content = {
    contractVersion: ATTENTION_WEBHOOK_CONTRACT_VERSION,
    workspaceId: parsed.workspaceId,
    eventId: parsed.eventId,
    eventSequence: parsed.eventSequence,
    kind: parsed.kind,
    recipientRef: parsed.recipientRef,
    commitmentId: parsed.commitmentId,
    reasonCode: parsed.reasonCode,
    summary: parsed.summary,
    occurredAt: parsed.occurredAt,
  };
  const payloadDigest = digest(content);
  const deliveryId = `attention:${digest({
    workspaceId: parsed.workspaceId,
    eventId: parsed.eventId,
    kind: parsed.kind,
    recipientRef: parsed.recipientRef,
  }).slice("sha256:".length)}`;
  return Object.freeze({ ...content, deliveryId, payloadDigest });
}

const Acknowledgement = z.object({
  contractVersion: z.literal("tasq.attention-webhook-ack.v1"),
  deliveryId: z.string().min(1).max(100),
  payloadDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  status: z.enum(["accepted", "duplicate"]),
  providerMessageId: z.string().min(1).max(500).nullable(),
  acceptedAt: z.number().int().nonnegative(),
}).strict();
export type AttentionAcknowledgement = z.infer<typeof Acknowledgement>;

export type AttentionDeliveryResult =
  | { outcome: "committed"; acknowledgement: AttentionAcknowledgement }
  | { outcome: "retry_same_delivery"; retryAfterMs: number; reason: string }
  | { outcome: "indeterminate"; reason: string }
  | { outcome: "failed"; reason: string };

export interface AttentionWebhookSinkOptions {
  endpoint: string;
  keyId: string;
  secret: string | Uint8Array;
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  maximumResponseBytes?: number;
}

export interface AttentionWebhookSink {
  deliver(envelope: DeliverableAttentionEnvelope): Promise<AttentionDeliveryResult>;
}

function retryAfter(response: Response): number {
  const value = response.headers.get("retry-after");
  if (value && /^(0|[1-9][0-9]*)$/.test(value)) return Math.min(Number(value) * 1_000, 300_000);
  return 1_000;
}

export function createAttentionWebhookSink(options: AttentionWebhookSinkOptions): AttentionWebhookSink {
  const endpoint = new URL(options.endpoint);
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password) {
    throw new Error("attention webhook endpoint must be credential-free HTTPS");
  }
  if (!options.keyId.trim() || options.keyId.length > 200) throw new Error("attention webhook keyId is invalid");
  const key = typeof options.secret === "string"
    ? new TextEncoder().encode(options.secret)
    : new Uint8Array(options.secret);
  if (key.byteLength < 32) throw new Error("attention webhook secret must contain at least 32 bytes");
  const fetcher = options.fetch ?? globalThis.fetch;
  const maximumResponseBytes = options.maximumResponseBytes ?? 16_384;
  if (!Number.isSafeInteger(maximumResponseBytes) || maximumResponseBytes < 256 || maximumResponseBytes > 65_536) {
    throw new Error("maximumResponseBytes is invalid");
  }
  return Object.freeze({
    async deliver(envelope: DeliverableAttentionEnvelope): Promise<AttentionDeliveryResult> {
      const canonical = canonicalizeEffectJson(envelope as never);
      const signature = createHmac("sha256", key).update(canonical).digest("base64url");
      let response: Response;
      try {
        response = await fetcher(endpoint, {
          method: "POST",
          redirect: "manual",
          headers: {
            "content-type": "application/json",
            "tasq-contract": envelope.contractVersion,
            "tasq-delivery-id": envelope.deliveryId,
            "tasq-payload-digest": envelope.payloadDigest,
            "tasq-signature": `hmac-sha256 key=${options.keyId},signature=${signature}`,
          },
          body: canonical,
        });
      } catch (error) {
        return { outcome: "indeterminate", reason: error instanceof Error ? error.message : "transport failure" };
      }
      if (response.status === 307 || response.status === 308 || (response.status >= 300 && response.status < 400)) {
        return { outcome: "failed", reason: "redirects are forbidden" };
      }
      if (response.status === 429 || response.status === 503) {
        return { outcome: "retry_same_delivery", retryAfterMs: retryAfter(response), reason: `receiver unavailable (${response.status})` };
      }
      if (response.status < 200 || response.status >= 300) {
        return { outcome: "failed", reason: `receiver rejected delivery (${response.status})` };
      }
      const declared = response.headers.get("content-length");
      if (declared && (!/^(0|[1-9][0-9]*)$/.test(declared) || Number(declared) > maximumResponseBytes)) {
        return { outcome: "indeterminate", reason: "acknowledgement exceeded response bound" };
      }
      const text = await response.text();
      if (new TextEncoder().encode(text).byteLength > maximumResponseBytes) {
        return { outcome: "indeterminate", reason: "acknowledgement exceeded response bound" };
      }
      try {
        const acknowledgement = Acknowledgement.parse(JSON.parse(text));
        if (acknowledgement.deliveryId !== envelope.deliveryId ||
          acknowledgement.payloadDigest !== envelope.payloadDigest) {
          return { outcome: "indeterminate", reason: "acknowledgement identity mismatch" };
        }
        return { outcome: "committed", acknowledgement };
      } catch {
        return { outcome: "indeterminate", reason: "acknowledgement is invalid" };
      }
    },
  });
}

export * from "./bounded-attention.js";
