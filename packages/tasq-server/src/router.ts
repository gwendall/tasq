import type { AuthorizationDecision } from "@tasq-internal/authority";
import type {
  AuthorityStore,
  WorkspaceAuthorizationResult,
  WorkspaceAuthorizationInput,
} from "./store.js";

export interface WorkspaceStorageBinding<T> {
  workspaceId: string;
  storageBindingId: string;
  open: () => Promise<T>;
}

export interface RoutedWorkspace<T> {
  decision: AuthorizationDecision;
  authorityRevision: number | null;
  replayedDecision: boolean;
  workspace: T | null;
}

export interface RoutedExecution<T> {
  decision: AuthorizationDecision;
  authorityRevision: number | null;
  replayedDecision: boolean;
  execution: T | null;
}

/**
 * Host-owned opaque binding registry. No path or credential is derived from a
 * caller-controlled workspace string, and no opener runs before an allow.
 */
export class IsolatedWorkspaceRouter<T> {
  private readonly bindings: ReadonlyMap<string, WorkspaceStorageBinding<T>>;

  constructor(
    private readonly authority: AuthorityStore,
    bindings: Iterable<WorkspaceStorageBinding<T>>,
  ) {
    const map = new Map<string, WorkspaceStorageBinding<T>>();
    for (const binding of bindings) {
      if (!binding.workspaceId || !binding.storageBindingId || typeof binding.open !== "function") {
        throw new Error("invalid workspace storage binding");
      }
      if (map.has(binding.storageBindingId)) throw new Error(`duplicate storage binding ${binding.storageBindingId}`);
      map.set(binding.storageBindingId, Object.freeze({ ...binding }));
    }
    this.bindings = map;
  }

  async authorizeAndOpen(input: WorkspaceAuthorizationInput): Promise<RoutedWorkspace<T>> {
    return this.route(input, await this.authority.authorize(input));
  }

  async authorizeAndOpenAt(input: WorkspaceAuthorizationInput, evaluatedAt: number): Promise<RoutedWorkspace<T>> {
    return this.route(input, await this.authority.authorizeAt(input, evaluatedAt));
  }

  /** Keep the authority write lock through the host's durable mutation commit. */
  async authorizeAndExecuteAt<R>(
    input: WorkspaceAuthorizationInput,
    evaluatedAt: number,
    execute: (workspace: T, authorization: WorkspaceAuthorizationResult) => Promise<R>,
  ): Promise<RoutedExecution<R>> {
    const result = await this.authority.authorizeAndExecuteAt(input, evaluatedAt, async (authorization) => {
      const binding = authorization.storageBindingId === null
        ? null
        : this.bindings.get(authorization.storageBindingId);
      if (!binding || binding.workspaceId !== input.workspaceId) {
        throw new Error("authorized workspace has no exact host storage binding");
      }
      return execute(await binding.open(), authorization);
    });
    return {
      decision: result.authorization.decision,
      authorityRevision: result.authorization.authorityRevision,
      replayedDecision: result.authorization.replayed,
      execution: result.execution,
    };
  }

  private async route(
    input: WorkspaceAuthorizationInput,
    authorization: Awaited<ReturnType<AuthorityStore["authorize"]>>,
  ): Promise<RoutedWorkspace<T>> {
    if (authorization.decision.decision !== "allow" || authorization.storageBindingId === null) {
      return {
        decision: authorization.decision,
        authorityRevision: authorization.authorityRevision,
        replayedDecision: authorization.replayed,
        workspace: null,
      };
    }
    const binding = this.bindings.get(authorization.storageBindingId);
    if (!binding || binding.workspaceId !== input.workspaceId) {
      throw new Error("authorized workspace has no exact host storage binding");
    }
    const workspace = await binding.open();
    return {
      decision: authorization.decision,
      authorityRevision: authorization.authorityRevision,
      replayedDecision: authorization.replayed,
      workspace,
    };
  }
}
