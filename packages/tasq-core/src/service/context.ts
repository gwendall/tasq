/** Profile-neutral service call context shared by kernel and compatibility layers. */

import type { Clock } from "@tasq-run/schema";

export interface ServiceContext {
  /** Actor performing the operation. */
  actor?: string;
  /** Stable transport-authenticated attribution; never an authority grant. */
  principalId?: string;
  /** Workspace/tenant identity. */
  tenantId?: string;
  /** Durable retry key for idempotent mutations. */
  idempotencyKey?: string;
  /** Optional optimistic concurrency guard. */
  expectedRevision?: number;
  /** Injected authoritative clock. */
  clock?: Clock;
  /** Explicit operation snapshot wins over the injected clock. */
  now?: number;
}
