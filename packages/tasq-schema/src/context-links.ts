/** Reusable external context stays outside Tasq; this contract stores links only. */

import { z } from "zod";
import { UuidV7 } from "./types.js";

export const EXTERNAL_CONTEXT_LINK_CONTRACT_VERSION =
  "tasq.external-context-link.v1" as const;
export const EXTERNAL_CONTEXT_LINK_PAGE_CONTRACT_VERSION =
  "tasq.external-context-link-page.v1" as const;
export const DEFAULT_EXTERNAL_CONTEXT_PURPOSE_URI =
  "https://schemas.tasq.dev/context-link-purposes/reference" as const;

const UnixMs = z.number().int().nonnegative();
const AbsoluteUri = z.string().trim().min(1).max(2_000).url();
const OptionalLabel = z.string().trim().min(1).max(500).nullable();

export const ExternalContextTarget = z.object({
  system: AbsoluteUri,
  resourceType: z.string().trim().min(1).max(120),
  externalId: z.string().trim().min(1).max(1_000),
  url: AbsoluteUri.nullable(),
  version: OptionalLabel,
  digest: OptionalLabel,
}).strict();
export type ExternalContextTarget = z.infer<typeof ExternalContextTarget>;

export const ExternalContextLinkState = z.enum(["active", "detached", "superseded"]);
export type ExternalContextLinkState = z.infer<typeof ExternalContextLinkState>;

export const ExternalContextLink = z.object({
  contractVersion: z.literal(EXTERNAL_CONTEXT_LINK_CONTRACT_VERSION),
  id: UuidV7,
  workspaceId: z.string().trim().min(1).max(500),
  commitmentId: UuidV7,
  purposeUri: AbsoluteUri,
  action: z.enum(["attach", "detach"]),
  supersedesLinkId: UuidV7.nullable(),
  target: ExternalContextTarget,
  binding: z.enum(["pinned", "floating"]),
  actorAlias: z.string().trim().min(1).max(500),
  principalId: z.string().trim().min(1).max(500),
  createdAt: UnixMs,
  state: ExternalContextLinkState,
}).strict().superRefine((value, context) => {
  const expectedBinding = value.target.version !== null || value.target.digest !== null
    ? "pinned" : "floating";
  if (value.binding !== expectedBinding) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["binding"],
      message: "binding must expose whether version or digest pins the external content",
    });
  }
  if (value.action === "detach" && value.supersedesLinkId === null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["supersedesLinkId"],
      message: "a detach record must supersede an existing link",
    });
  }
  if ((value.state === "active" && value.action !== "attach") ||
      (value.state === "detached" && value.action !== "detach")) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["state"],
      message: "state must agree with the immutable append action",
    });
  }
});
export type ExternalContextLink = z.infer<typeof ExternalContextLink>;

export const AttachExternalContextLinkInput = z.object({
  id: UuidV7.optional(),
  workspaceId: z.string().trim().min(1).max(500),
  commitmentId: UuidV7,
  purposeUri: AbsoluteUri.default(DEFAULT_EXTERNAL_CONTEXT_PURPOSE_URI),
  target: ExternalContextTarget,
  expectedPreviousLinkId: UuidV7.nullable().default(null),
}).strict().superRefine((value, context) => {
  if (value.id !== undefined && value.id === value.expectedPreviousLinkId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["expectedPreviousLinkId"],
      message: "a context link cannot supersede itself",
    });
  }
});
/** Caller shape: defaulted purpose/CAS fields may be omitted. */
export type AttachExternalContextLinkInput = z.input<typeof AttachExternalContextLinkInput>;
/** Parsed service shape after defaults have been applied. */
export type NormalizedAttachExternalContextLinkInput = z.output<
  typeof AttachExternalContextLinkInput
>;

export const DetachExternalContextLinkInput = z.object({
  id: UuidV7.optional(),
  workspaceId: z.string().trim().min(1).max(500),
  expectedPreviousLinkId: UuidV7,
}).strict().superRefine((value, context) => {
  if (value.id !== undefined && value.id === value.expectedPreviousLinkId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["expectedPreviousLinkId"],
      message: "a context link cannot supersede itself",
    });
  }
});
export type DetachExternalContextLinkInput = z.infer<typeof DetachExternalContextLinkInput>;

export const ExternalContextLinkPage = z.object({
  contractVersion: z.literal(EXTERNAL_CONTEXT_LINK_PAGE_CONTRACT_VERSION),
  items: z.array(ExternalContextLink).max(10_000),
  selection: z.object({
    mode: z.literal("current_active"),
    excludes: z.tuple([z.literal("detached"), z.literal("superseded")]),
    emptyDoesNotProveNoHistory: z.literal(true),
    historyRecipeId: z.literal("context-link.history"),
  }).strict().optional(),
}).strict().superRefine((value, context) => {
  if (value.selection && value.items.some((item) => item.state !== "active")) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["items"],
      message: "a current-active page cannot contain detached or superseded links",
    });
  }
});
export type ExternalContextLinkPage = z.infer<typeof ExternalContextLinkPage>;
