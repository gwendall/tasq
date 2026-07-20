import { createHash } from "node:crypto";
import { canonicalizeEffectJson } from "@tasq/schema";

export const WORK_ITEM_OBSERVATION_TYPE_URI =
  "https://schemas.tasq.dev/observations/reference-work-item/snapshot" as const;
export const WORK_ITEM_COMMENT_EFFECT_TYPE_URI =
  "https://schemas.tasq.dev/effects/reference-work-item/comment-create" as const;
export const WORK_ITEM_COMMENT_OPERATION_URI =
  "https://schemas.tasq.dev/connectors/reference-work-item/comment-create" as const;
export const WORK_ITEM_READ_CONNECTOR_URI =
  "https://schemas.tasq.dev/connectors/reference-work-item-reader" as const;
export const WORK_ITEM_EFFECT_CONNECTOR_URI =
  "https://schemas.tasq.dev/connectors/reference-work-item-commenter" as const;
export const REFERENCE_CONNECTOR_VERSION = "1.0.0" as const;
export const WORK_ITEM_SCHEMA_VERSION = 1 as const;
export const WORK_ITEM_OPERATION_VERSION = 1 as const;

export const WORK_ITEM_COMMENT_CONTRACT = Object.freeze({
  protocol: "tasq.reference-work-item-comment.v1",
  parameters: Object.freeze([
    "providerAccountRef",
    "projectRef",
    "itemRef",
    "bodyRef",
    "bodyDigest",
    "bodyBytes",
  ]),
  providerIdempotencyHeader: "Idempotency-Key",
  lookup: "by-dispatch-identity",
  receipt: "hmac-sha256",
});

export function sha256(value: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export const WORK_ITEM_COMMENT_CONTRACT_DIGEST = sha256(
  canonicalizeEffectJson(WORK_ITEM_COMMENT_CONTRACT),
);

export const PROVIDER_RECEIPT_COVERAGE = Object.freeze([
  "provider_account",
  "provider_operation",
  "request_identity",
  "outcome",
] as const);
