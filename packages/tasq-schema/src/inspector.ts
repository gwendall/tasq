/** Read-only web-inspector index contract. Canonical graph detail remains tasq.inspect.v1. */

import { z } from "zod";
import { TaskStatus, UuidV7 } from "./types.js";

export const INSPECTOR_INDEX_CONTRACT_VERSION = "tasq.inspector-index.v1" as const;

const Count = z.number().int().nonnegative();
const UnixMs = z.number().int().nonnegative();

export const InspectorSignalCounts = z.object({
  waits: Count,
  waiting: Count,
  effects: Count,
  unresolvedEffects: Count,
  authorityDecisions: Count,
  receipts: Count,
}).strict();
export type InspectorSignalCounts = z.infer<typeof InspectorSignalCounts>;

export const InspectorIndexItem = z.object({
  commitmentId: UuidV7,
  title: z.string().min(1).max(500),
  status: TaskStatus,
  revision: z.number().int().nonnegative(),
  priority: z.number().int().min(1).max(5).nullable(),
  dueAt: UnixMs.nullable(),
  updatedAt: UnixMs,
  signals: InspectorSignalCounts,
}).strict();
export type InspectorIndexItem = z.infer<typeof InspectorIndexItem>;

export const InspectorIndex = z.object({
  contractVersion: z.literal(INSPECTOR_INDEX_CONTRACT_VERSION),
  inspectedAt: UnixMs,
  workspaceId: z.string().trim().min(1).max(500),
  filter: z.object({
    status: TaskStatus.nullable(),
    query: z.string().min(1).max(200).nullable(),
    limit: z.number().int().min(1).max(100),
  }).strict(),
  matched: Count,
  truncated: z.boolean(),
  items: z.array(InspectorIndexItem).max(100),
}).strict().superRefine((value, context) => {
  if (value.items.length > value.matched) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["matched"],
      message: "matched cannot be smaller than the returned item count",
    });
  }
  if (value.truncated !== (value.matched > value.items.length)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["truncated"],
      message: "truncated must disclose whether matched items were omitted",
    });
  }
});
export type InspectorIndex = z.infer<typeof InspectorIndex>;
