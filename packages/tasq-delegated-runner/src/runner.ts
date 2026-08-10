/**
 * Reference delegated-action runtime.
 *
 * Core remains the sole domain ledger. This runtime owns only execution
 * policy: event delivery leases, timers, connector selection and recovery.
 */
import { createHash } from "node:crypto";
import {
  beginEffectExecution,
  completeDelivery,
  ensureDeliverySink,
  evaluateSettlementOrRecourse,
  failDelivery,
  getEffect,
  getTaskClaim,
  leaseNextDelivery,
  recordEffectReceipt,
  type TasqDb,
} from "@tasq-run/core";
import type {
  EffectConnectorPolicy,
  EffectPermitIssuer,
  VerifiedEffectReceipt,
} from "@tasq-run/extension-sdk";
import {
  SettlementEvaluationInputV1,
  canonicalizeEffectJson,
  settlementPolicyDigest,
  type Clock,
  type Effect,
  type EffectDispatchPermit,
  type EffectReceiptReport,
  type Event,
  type SettlementEvaluationInputV1 as SettlementInput,
  type SettlementViewV1,
} from "@tasq-run/schema";

export interface DelegatedEffectConnectorResult {
  outcome: "committed" | "failed" | "indeterminate";
  dispatchIdempotencyKey: string;
  providerOperationId: string | null;
  report: EffectReceiptReport;
}

export interface EffectDispatchBoundary {
  /** Must be called adjacent to, and before, the provider mutation. */
  assertLiveAuthority(): Promise<void>;
}

/** Provider credentials stay inside this injected connector implementation. */
export interface DelegatedEffectConnector {
  readonly policy: EffectConnectorPolicy;
  dispatch(
    permit: unknown,
    boundary: EffectDispatchBoundary,
  ): Promise<DelegatedEffectConnectorResult>;
  lookup(
    permit: unknown,
    options?: { resolvesReceiptId?: string | null },
  ): Promise<DelegatedEffectConnectorResult>;
  verifyReceipt(report: unknown): VerifiedEffectReceipt;
}

export interface RunnerEventContext {
  event: Event;
  deliveryId: string;
  /** Stable idempotency identity for any work caused by this event. */
  idempotencyKey: string;
}

export interface ReferenceDelegatedRunnerOptions {
  db: TasqDb;
  workspaceId: string;
  principalId: string;
  actor?: string;
  runnerId: string;
  configurationDigest: `sha256:${string}`;
  clock: Clock;
  permitIssuer: EffectPermitIssuer;
  connectors: readonly DelegatedEffectConnector[];
  eventHandler?: (context: RunnerEventContext) => Promise<void>;
  leaseMs?: number;
  maxDeliveryAttempts?: number;
}

export type EffectRunResult = Readonly<{
  effect: Effect;
  action: "dispatched" | "looked_up" | "waiting_for_lookup" | "terminal";
}>;

export interface EffectExecutionBinding {
  claimId: string;
  fence: number;
}

function connectorKey(policy: EffectConnectorPolicy): string {
  return `${policy.instanceRef}\0${policy.bindingDigest}`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * An executing effect has consumed one revision at begin; an indeterminate
 * effect consumed one more when its unknown-outcome receipt was recorded.
 * This reconstructs the exact idempotent begin request after a process crash.
 */
function authorizedRevision(effect: Effect): number {
  if (effect.status === "authorized") return effect.revision;
  if (effect.status === "executing") return effect.revision - 1;
  if (effect.status === "indeterminate") return effect.revision - 2;
  throw new Error(`Effect ${effect.id} has no recoverable execution basis from ${effect.status}`);
}

export class ReferenceDelegatedRunner {
  readonly #db: TasqDb;
  readonly #workspaceId: string;
  readonly #principalId: string;
  readonly #actor: string;
  readonly #runnerId: string;
  readonly #configurationDigest: `sha256:${string}`;
  readonly #clock: Clock;
  readonly #permitIssuer: EffectPermitIssuer;
  readonly #connectors: ReadonlyMap<string, DelegatedEffectConnector>;
  readonly #eventHandler: (context: RunnerEventContext) => Promise<void>;
  readonly #leaseMs: number;
  readonly #maxDeliveryAttempts: number;

  constructor(options: ReferenceDelegatedRunnerOptions) {
    if (!options.workspaceId.trim() || !options.principalId.trim() || !options.runnerId.trim()) {
      throw new Error("workspaceId, principalId and runnerId are required");
    }
    if (!/^sha256:[0-9a-f]{64}$/.test(options.configurationDigest)) {
      throw new Error("configurationDigest must be a lowercase SHA-256 digest");
    }
    this.#db = options.db;
    this.#workspaceId = options.workspaceId;
    this.#principalId = options.principalId;
    this.#actor = options.actor ?? options.runnerId;
    this.#runnerId = options.runnerId;
    this.#configurationDigest = options.configurationDigest;
    this.#clock = options.clock;
    this.#permitIssuer = options.permitIssuer;
    this.#eventHandler = options.eventHandler ?? (async () => {});
    this.#leaseMs = options.leaseMs ?? 30_000;
    this.#maxDeliveryAttempts = options.maxDeliveryAttempts ?? 5;
    if (!Number.isSafeInteger(this.#leaseMs) || this.#leaseMs <= 0) {
      throw new Error("leaseMs must be a positive safe integer");
    }
    if (!Number.isSafeInteger(this.#maxDeliveryAttempts) || this.#maxDeliveryAttempts <= 0) {
      throw new Error("maxDeliveryAttempts must be a positive safe integer");
    }
    const entries = options.connectors.map((connector) => [connectorKey(connector.policy), connector] as const);
    if (new Set(entries.map(([key]) => key)).size !== entries.length) {
      throw new Error("connector bindings must be unique");
    }
    this.#connectors = new Map(entries);
  }

  /** Registers one durable outbox sink. Existing identities cannot be rebound. */
  async start(): Promise<void> {
    await ensureDeliverySink(this.#db, {
      id: this.#runnerId,
      kind: "tasq.reference-delegated-runner.v1",
      configurationDigest: this.#configurationDigest,
    }, { tenantId: this.#workspaceId, clock: this.#clock });
  }

  /**
   * Process at most one event. Completion is persisted only after the handler
   * returns; a crash therefore re-leases the same event and stable key.
   */
  async processNextEvent(): Promise<"idle" | "delivered" | "retry" | "quarantined"> {
    const leased = await leaseNextDelivery(this.#db, this.#runnerId, {
      tenantId: this.#workspaceId,
      leaseOwner: this.#runnerId,
      leaseMs: this.#leaseMs,
      clock: this.#clock,
    });
    if (!leased) return "idle";
    try {
      await this.#eventHandler({
        event: leased.event,
        deliveryId: leased.delivery.id,
        idempotencyKey: `runner:event:${this.#runnerId}:${leased.event.id}`,
      });
      await completeDelivery(this.#db, leased.delivery.id, {
        tenantId: this.#workspaceId,
        leaseOwner: this.#runnerId,
        clock: this.#clock,
      });
      return "delivered";
    } catch (error) {
      const failed = await failDelivery(this.#db, leased.delivery.id, {
        tenantId: this.#workspaceId,
        leaseOwner: this.#runnerId,
        error: message(error),
        maxAttempts: this.#maxDeliveryAttempts,
        clock: this.#clock,
      });
      return failed.status === "quarantined" ? "quarantined" : "retry";
    }
  }

  async drainEvents(limit = 100): Promise<Readonly<{ delivered: number; stopped: string }>> {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 10_000) {
      throw new Error("event drain limit must be an integer in 1..10000");
    }
    let delivered = 0;
    while (delivered < limit) {
      const result = await this.processNextEvent();
      if (result !== "delivered") return Object.freeze({ delivered, stopped: result });
      delivered += 1;
    }
    return Object.freeze({ delivered, stopped: "limit" });
  }

  #connector(effect: Effect): DelegatedEffectConnector {
    const policyBinding = {
      instanceRef: effect.request.connector.instanceRef,
      bindingDigest: effect.request.connector.bindingDigest,
    };
    const found = this.#connectors.get(`${policyBinding.instanceRef}\0${policyBinding.bindingDigest}`);
    if (!found) throw new Error(`No connector for exact effect binding ${policyBinding.instanceRef}`);
    return found;
  }

  async #livePermit(
    effect: Effect,
    connector: DelegatedEffectConnector,
    binding: EffectExecutionBinding,
  ): Promise<EffectDispatchPermit> {
    const begun = await beginEffectExecution(this.#db, effect.id, {
      tenantId: this.#workspaceId,
      actor: this.#actor,
      principalId: this.#principalId,
      idempotencyKey: `runner:effect-begin:${effect.id}`,
      expectedRevision: authorizedRevision(effect),
      claimId: binding.claimId,
      fence: binding.fence,
      policy: connector.policy,
      permitIssuer: this.#permitIssuer,
      clock: this.#clock,
    });
    return begun.permit;
  }

  async #assertLiveFence(permit: EffectDispatchPermit): Promise<void> {
    const claim = await getTaskClaim(this.#db, permit.payload.claim.id, this.#workspaceId);
    const now = this.#clock.now();
    if (!claim || claim.taskId !== permit.payload.taskId || claim.principalId !== this.#principalId ||
      claim.releasedAt != null || claim.expiresAt <= now || claim.fence !== permit.payload.claim.fence ||
      claim.expiresAt !== permit.payload.claim.expiresAt) {
      throw new Error("Effect dispatch stopped: live claim fence no longer matches the permit");
    }
  }

  /**
   * Dispatch a newly authorized effect, or recover an executing/indeterminate
   * one by provider lookup. A persisted execution state is never blind-retried.
   */
  async runEffect(effectId: string, execution?: EffectExecutionBinding): Promise<EffectRunResult> {
    let effect = await getEffect(this.#db, effectId, this.#workspaceId);
    if (!effect) throw new Error(`Effect not found: ${effectId}`);
    if (["committed", "failed", "cancelled"].includes(effect.status)) {
      return Object.freeze({ effect, action: "terminal" });
    }
    if (effect.status === "proposed") throw new Error("Effect requires exact approval and authorization before dispatch");
    const connector = this.#connector(effect);
    const freshDispatch = effect.status === "authorized";
    let permit: EffectDispatchPermit;
    if (freshDispatch) {
      if (!effect.attemptId) throw new Error("Authorized effect must be attached to a running attempt");
      // beginEffectExecution performs the authoritative claim/fence check in
      // the same transaction that enters executing.
      if (!execution) throw new Error("First dispatch requires the current claim id and fence");
      permit = await this.#livePermit(effect, connector, execution);
    } else {
      if (!effect.claimId || effect.fence == null) {
        throw new Error(`Effect ${effect.id} has no recoverable execution fence`);
      }
      if (execution && (execution.claimId !== effect.claimId || execution.fence !== effect.fence)) {
        throw new Error("Recovery binding differs from the persisted effect fence");
      }
      permit = await this.#livePermit(effect, connector, {
        claimId: effect.claimId,
        fence: effect.fence,
      });
    }

    // The connector must invoke this online guard adjacent to provider I/O.
    // It independently authenticates the signed permit, scope and expiry.
    let guardCalled = false;
    const result = freshDispatch
      ? await connector.dispatch(permit, {
          assertLiveAuthority: async () => {
            await this.#assertLiveFence(permit);
            guardCalled = true;
          },
        })
      : await connector.lookup(permit, { resolvesReceiptId: effect.status === "indeterminate" ? effect.outcomeReceiptId : null });
    if (freshDispatch && !guardCalled) {
      throw new Error("Connector violated dispatch contract: live authority guard was not called");
    }
    if (result.dispatchIdempotencyKey !== permit.payload.dispatchIdempotencyKey) {
      throw new Error("Connector result changed the effect dispatch identity");
    }
    effect = await getEffect(this.#db, effectId, this.#workspaceId);
    if (!effect) throw new Error(`Effect disappeared during dispatch: ${effectId}`);
    if (result.outcome === "indeterminate" && effect.status === "indeterminate") {
      return Object.freeze({ effect, action: "waiting_for_lookup" });
    }
    const verified = connector.verifyReceipt(result.report);
    await recordEffectReceipt(this.#db, { report: result.report }, {
      tenantId: this.#workspaceId,
      actor: this.#actor,
      principalId: this.#principalId,
      expectedRevision: effect.revision,
      verifier: {
        verify({ report }) {
          if (canonicalizeEffectJson(report) !== canonicalizeEffectJson(result.report)) {
            throw new Error("Receipt verifier was invoked with different report bytes");
          }
          return verified;
        },
      },
      clock: this.#clock,
    });
    const after = await getEffect(this.#db, effectId, this.#workspaceId);
    if (!after) throw new Error(`Effect disappeared after receipt: ${effectId}`);
    return Object.freeze({
      effect: after,
      action: freshDispatch ? "dispatched" : "looked_up",
    });
  }

  /** Core's idempotency record and unique decision root are the exactly-once boundary. */
  async materializeSettlementOrRecourse(input: SettlementInput): Promise<SettlementViewV1> {
    const parsed = SettlementEvaluationInputV1.parse(input);
    const root = parsed.priorSettlementDecisionId ?? `agreement:${parsed.agreementOfferId}:${parsed.obligationId}`;
    const identity = createHash("sha256")
      .update(`tasq.reference-runner.settlement.v1\0${root}\0${settlementPolicyDigest(parsed.policy)}`)
      .digest("hex");
    return evaluateSettlementOrRecourse(this.#db, parsed, {
      tenantId: this.#workspaceId,
      actor: this.#actor,
      principalId: this.#principalId,
      idempotencyKey: `runner:settlement:${identity}`,
      clock: this.#clock,
    });
  }
}
