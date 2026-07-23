/**
 * TQ-208: cross-domain adversarial acceptance for the complete effect boundary.
 *
 * These scenarios use only public kernel and connector-SDK contracts. Provider
 * I/O is represented by an in-memory black box with real idempotency semantics;
 * every ledger and boundary time comes from one controlled clock.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  createHmacEffectPermitAuthenticator,
  enforceEffectDispatch,
  type EffectConnectorPolicy,
  type EffectReceiptVerifier,
} from "@tasq-run/extension-sdk";
import {
  canonicalizeEffectJson,
  createMutableClock,
  type EffectDispatchPermit,
  type EffectJsonObject,
  type EffectReceiptReport,
} from "@tasq-run/schema";
import {
  acquireTaskClaim,
  authorizeEffect,
  beginEffectExecution,
  cancelEffect,
  createCommitment,
  createPrincipal,
  diagnoseStore,
  getCommitment,
  getEffect,
  inspectCommitment,
  installExtension,
  listEffectReceipts,
  openDb,
  proposeEffect,
  recordEffectApproval,
  recordEffectReceipt,
  runMigrations,
  startTaskAttempt,
} from "@tasq-internal/local-service";

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

const A = "a".repeat(64);
const B = "b".repeat(64);
const R = "c".repeat(64);
const AUTHENTICATOR = createHmacEffectPermitAuthenticator("eval-permit-key", "k".repeat(32));
const WORKSPACE = "tq-208-adversarial";

const DOMAINS = ["money", "communication", "filesystem", "deployment"] as const;
type Domain = typeof DOMAINS[number];

function binding(domain: Domain) {
  return {
    effectTypeUri: `https://eval.example/effects/${domain}`,
    operationUri: `https://eval.example/connectors/${domain}/execute`,
    contractDigest: `sha256:${A}`,
    instanceRef: `connector:${domain}:protected-account`,
    bindingDigest: `sha256:${B}`,
  };
}

function request(domain: Domain, parameters: EffectJsonObject, workspaceId = WORKSPACE) {
  const exact = binding(domain);
  return {
    protocol: "tasq.effect-request.v1" as const,
    canonicalization: "tasq.jcs-safe-integer.v1" as const,
    digestAlgorithm: "sha-256" as const,
    workspaceId,
    effectTypeUri: exact.effectTypeUri,
    effectSchemaVersion: 1,
    connector: {
      operationUri: exact.operationUri,
      operationVersion: 1,
      contractDigest: exact.contractDigest,
      instanceRef: exact.instanceRef,
      bindingDigest: exact.bindingDigest,
    },
    parameters,
    secretBindings: [],
  };
}

function exactObject(input: unknown, keys: readonly string[]): EffectJsonObject {
  if (input === null || Array.isArray(input) || typeof input !== "object") {
    throw new Error("parameters must be an object");
  }
  const value = input as EffectJsonObject;
  if (Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")) {
    throw new Error("parameter keys do not match the registered connector operation");
  }
  canonicalizeEffectJson(value);
  return value;
}

function policy(
  domain: Domain,
  keys: readonly string[],
  allowed: (input: {
    parameters: EffectJsonObject;
    scope: EffectJsonObject;
    limits: EffectJsonObject;
  }) => boolean,
): EffectConnectorPolicy {
  const exact = binding(domain);
  return {
    effectTypeUri: exact.effectTypeUri,
    effectSchemaVersion: 1,
    operationUri: exact.operationUri,
    operationVersion: 1,
    contractDigest: exact.contractDigest,
    instanceRef: exact.instanceRef,
    bindingDigest: exact.bindingDigest,
    parseParameters: (input) => exactObject(input, keys),
    evaluateAuthority(input) {
      const ok = input.verificationLevel !== "self_asserted" && allowed(input);
      return {
        allowed: ok,
        reasonCode: ok ? "exact_authority" : "outside_exact_authority",
        explanation: ok ? "The exact protected operation is authorized." : "The operation exceeds or changes authority.",
      };
    },
  };
}

interface World {
  db: Awaited<ReturnType<typeof openDb>>["db"];
  client: Awaited<ReturnType<typeof openDb>>["client"];
  close: Awaited<ReturnType<typeof openDb>>["close"];
  clock: ReturnType<typeof createMutableClock>;
  workerId: string;
  approverId: string;
}

async function world(workspaceId = WORKSPACE): Promise<World> {
  const dir = mkdtempSync(join(tmpdir(), "tasq-tq208-"));
  tmpDirs.push(dir);
  const handle = await openDb({ url: `file:${join(dir, "db.sqlite")}`, wal: false });
  const clock = createMutableClock(100_000);
  await runMigrations(handle.client, { clock });
  const worker = await createPrincipal(handle.db, {
    tenantId: workspaceId, kind: "runtime", displayName: "Protected connector runtime",
  }, { tenantId: workspaceId, clock });
  clock.advance(1);
  const approver = await createPrincipal(handle.db, {
    tenantId: workspaceId, kind: "human", displayName: "Authenticated approver",
  }, { tenantId: workspaceId, clock });
  clock.advance(1);
  await installExtension(handle.db, {
    extensionUri: "https://eval.example/extensions/protected-effects",
    version: "1.0.0",
    types: DOMAINS.map((domain) => ({
      recordKind: "effect" as const,
      typeUri: binding(domain).effectTypeUri,
      schemaVersion: 1,
      schema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        additionalProperties: true,
      },
    })),
    evaluators: [],
  }, { tenantId: workspaceId, actor: "protected-connector-runtime", clock });
  clock.advance(1);
  return { ...handle, clock, workerId: worker.id, approverId: approver.id };
}

async function authorized(
  value: World,
  domain: Domain,
  parameters: EffectJsonObject,
  scope: EffectJsonObject,
  limits: EffectJsonObject,
) {
  const task = await createCommitment(value.db, {
    title: `Safely execute ${domain}`,
    completionPolicy: "evidence",
    successCriteria: "A verified provider receipt exists and is separately reviewed",
  }, {
    workspaceId: WORKSPACE,
    actor: "protected-connector-runtime",
    principalId: value.workerId,
    clock: value.clock,
  });
  value.clock.advance(1);
  const claim = await acquireTaskClaim(value.db, task.id, {
    tenantId: WORKSPACE,
    principalId: value.workerId,
    leaseMs: 10_000,
    clock: value.clock,
  });
  value.clock.advance(1);
  const attempt = await startTaskAttempt(value.db, task.id, {
    tenantId: WORKSPACE,
    principalId: value.workerId,
    claimId: claim.id,
    occurredAt: value.clock.now(),
    clock: value.clock,
  });
  value.clock.advance(1);
  const proposed = await proposeEffect(value.db, {
    tenantId: WORKSPACE,
    taskId: task.id,
    attemptId: attempt.id,
    request: request(domain, parameters),
  }, { tenantId: WORKSPACE, principalId: value.workerId, clock: value.clock });
  value.clock.advance(1);
  const approval = await recordEffectApproval(value.db, {
    tenantId: WORKSPACE,
    effectId: proposed.id,
    decision: "approved",
    scope,
    limits,
    expiresAt: value.clock.now() + 5_000,
  }, {
    tenantId: WORKSPACE,
    principalId: value.approverId,
    authorityVerification: {
      level: "cryptographic",
      method: "eval-authenticated-approval",
      details: { keyId: "approver-key:1" },
    },
    clock: value.clock,
  });
  value.clock.advance(1);
  const effect = await authorizeEffect(value.db, proposed.id, approval.id, {
    tenantId: WORKSPACE,
    principalId: value.workerId,
    expectedRevision: proposed.revision,
    clock: value.clock,
  });
  return { task, claim, attempt, effect, approval };
}

async function begin(value: World, prepared: Awaited<ReturnType<typeof authorized>>, connectorPolicy: EffectConnectorPolicy) {
  value.clock.advance(1);
  return beginEffectExecution(value.db, prepared.effect.id, {
    tenantId: WORKSPACE,
    principalId: value.workerId,
    expectedRevision: prepared.effect.revision,
    claimId: prepared.claim.id,
    fence: prepared.claim.fence,
    policy: connectorPolicy,
    permitIssuer: AUTHENTICATOR,
    clock: value.clock,
  });
}

class IdempotentProvider {
  readonly operations = new Map<string, { operationId: string; canonicalParameters: string }>();

  apply(permit: EffectDispatchPermit, connectorPolicy: EffectConnectorPolicy, now: number) {
    const accepted = enforceEffectDispatch(permit, connectorPolicy, { verifier: AUTHENTICATOR, now });
    const key = permit.payload.dispatchIdempotencyKey;
    const canonicalParameters = canonicalizeEffectJson(accepted.parameters);
    const prior = this.operations.get(key);
    if (prior) {
      if (prior.canonicalParameters !== canonicalParameters) throw new Error("provider idempotency parameter mismatch");
      return prior;
    }
    const result = { operationId: `provider-op:${this.operations.size + 1}`, canonicalParameters };
    this.operations.set(key, result);
    return result;
  }
}

function report(
  begun: Awaited<ReturnType<typeof begin>>,
  operationId: string | null,
  outcome: "committed" | "failed" | "indeterminate",
  occurredAt: number,
  options: { delivery?: string; resolvesReceiptId?: string | null; account?: string; signature?: string } = {},
): EffectReceiptReport {
  const effect = begun.effect;
  return {
    protocol: "tasq.effect-receipt.v1",
    workspaceId: effect.tenantId,
    effectId: effect.id,
    requestDigest: effect.requestDigest,
    dispatchIdempotencyKey: effect.dispatchIdempotencyKey,
    approvalId: begun.permit.payload.approval.id,
    claimId: begun.permit.payload.claim.id,
    fence: begun.permit.payload.claim.fence,
    connectorInstanceRef: effect.request.connector.instanceRef,
    connectorBindingDigest: effect.request.connector.bindingDigest,
    externalReceiptId: options.delivery ?? `delivery:${outcome}:${effect.id}`,
    providerOperationId: operationId,
    outcome,
    occurredAt,
    rawRef: `urn:eval-receipt:${effect.id}:${outcome}`,
    rawDigest: `sha256:${R}`,
    payload: {
      providerAccount: options.account ?? "protected-account",
      providerStatus: outcome,
      signature: options.signature ?? "valid",
    },
    resolvesReceiptId: options.resolvesReceiptId ?? null,
  };
}

const strongVerifier: EffectReceiptVerifier = {
  verify({ report: value }) {
    if (value.payload.providerAccount !== "protected-account" || value.payload.signature !== "valid") {
      throw new Error("provider receipt authentication or account binding failed");
    }
    return {
      level: "cryptographic",
      method: "eval-provider-signature",
      coverage: ["provider_account", "provider_operation", "request_identity", "outcome"],
      details: { keyId: "provider-key:1", account: "protected-account" },
    };
  },
};

const weakVerifier: EffectReceiptVerifier = {
  verify: () => ({ level: "self_asserted", method: "caller-json", coverage: ["outcome"], details: {} }),
};

const incompleteVerifier: EffectReceiptVerifier = {
  verify: () => ({
    level: "cryptographic",
    method: "signature-with-insufficient-components",
    coverage: ["provider_account", "outcome"],
    details: {},
  }),
};

describe("TQ-208 adversarial effect acceptance", () => {
  test("money mutation, duplicate dispatch and receipt attacks fail closed", async () => {
    const value = await world();
    try {
      const connectorPolicy = policy(
        "money",
        ["account", "amountMinor", "currency", "recipient"],
        ({ parameters, scope, limits }) =>
          parameters.account === scope.account && parameters.recipient === scope.recipient &&
          parameters.currency === "EUR" && Number(parameters.amountMinor) <= Number(limits.maxAmountMinor),
      );
      const prepared = await authorized(value, "money", {
        account: "protected-account", amountMinor: 5_800, currency: "EUR", recipient: "alice",
      }, { account: "protected-account", recipient: "alice" }, { maxAmountMinor: 5_800 });
      const begun = await begin(value, prepared, connectorPolicy);
      const provider = new IdempotentProvider();
      const first = provider.apply(begun.permit, connectorPolicy, value.clock.now());
      const retry = provider.apply(begun.permit, connectorPolicy, value.clock.now());
      expect(retry).toEqual(first);
      expect(provider.operations.size).toBe(1);

      for (const parameters of [
        { ...begun.permit.payload.request.parameters, amountMinor: 580_000 },
        { ...begun.permit.payload.request.parameters, recipient: "mallory" },
        { ...begun.permit.payload.request.parameters, account: "other-account" },
      ]) {
        const tampered = {
          ...begun.permit,
          payload: {
            ...begun.permit.payload,
            request: { ...begun.permit.payload.request, parameters },
          },
        };
        expect(() => provider.apply(tampered as EffectDispatchPermit, connectorPolicy, value.clock.now()))
          .toThrow(/authentication/);
      }
      expect(provider.operations.size).toBe(1);

      const authentic = report(begun, first.operationId, "committed", value.clock.now());
      await expect(recordEffectReceipt(value.db, { report: authentic }, {
        tenantId: WORKSPACE, principalId: value.workerId, expectedRevision: begun.effect.revision,
        verifier: weakVerifier, clock: value.clock,
      })).rejects.toThrow(/strong verification/);
      await expect(recordEffectReceipt(value.db, { report: authentic }, {
        tenantId: WORKSPACE, principalId: value.workerId, expectedRevision: begun.effect.revision,
        verifier: incompleteVerifier, clock: value.clock,
      })).rejects.toThrow(/complete coverage/);
      await expect(recordEffectReceipt(value.db, {
        report: report(begun, first.operationId, "committed", value.clock.now(), { account: "other-account" }),
      }, {
        tenantId: WORKSPACE, principalId: value.workerId, expectedRevision: begun.effect.revision,
        verifier: strongVerifier, clock: value.clock,
      })).rejects.toThrow(/account binding/);
      await expect(recordEffectReceipt(value.db, {
        report: report(begun, first.operationId, "committed", value.clock.now(), { signature: "forged" }),
      }, {
        tenantId: WORKSPACE, principalId: value.workerId, expectedRevision: begun.effect.revision,
        verifier: strongVerifier, clock: value.clock,
      })).rejects.toThrow(/authentication/);

      const receipt = await recordEffectReceipt(value.db, { report: authentic }, {
        tenantId: WORKSPACE, principalId: value.workerId, expectedRevision: begun.effect.revision,
        verifier: strongVerifier, clock: value.clock,
      });
      expect((await getEffect(value.db, begun.effect.id, WORKSPACE))?.status).toBe("committed");
      expect((await getCommitment(value.db, prepared.task.id, WORKSPACE))?.status).toBe("open");
      const replay = await recordEffectReceipt(value.db, { report: authentic }, {
        tenantId: WORKSPACE, principalId: value.workerId, expectedRevision: begun.effect.revision,
        verifier: strongVerifier, clock: value.clock,
      });
      expect(replay.id).toBe(receipt.id);
      await expect(recordEffectReceipt(value.db, {
        report: { ...authentic, payload: { ...authentic.payload, providerStatus: "changed" } },
      }, {
        tenantId: WORKSPACE, principalId: value.workerId, expectedRevision: receipt.recordedAt,
        verifier: strongVerifier, clock: value.clock,
      })).rejects.toThrow(/reused with different content/);
    } finally {
      await value.close();
    }
  });

  test("important communication timeout remains indeterminate until authenticated lookup", async () => {
    const value = await world();
    try {
      const connectorPolicy = policy(
        "communication",
        ["attachmentDigest", "bcc", "bodyDigest", "headers", "recipient", "subject"],
        ({ parameters, scope }) => parameters.recipient === scope.recipient &&
          parameters.subject === scope.subject && parameters.bodyDigest === scope.bodyDigest &&
          parameters.attachmentDigest === scope.attachmentDigest &&
          parameters.bcc === "" && canonicalizeEffectJson(parameters.headers) === "{}",
      );
      const prepared = await authorized(value, "communication", {
        recipient: "board@example.test",
        subject: "Exact board notice",
        bodyDigest: `sha256:${A}`,
        attachmentDigest: `sha256:${B}`,
        bcc: "",
        headers: {},
      }, {
        recipient: "board@example.test",
        subject: "Exact board notice",
        bodyDigest: `sha256:${A}`,
        attachmentDigest: `sha256:${B}`,
      }, {});
      const begun = await begin(value, prepared, connectorPolicy);
      const provider = new IdempotentProvider();
      const operation = provider.apply(begun.permit, connectorPolicy, value.clock.now());

      for (const mutation of [
        { bcc: "exfil@example.test" },
        { headers: { "x-injected": "true" } },
        { attachmentDigest: `sha256:${R}` },
      ]) {
        const tampered = {
          ...begun.permit,
          payload: {
            ...begun.permit.payload,
            request: {
              ...begun.permit.payload.request,
              parameters: { ...begun.permit.payload.request.parameters, ...mutation },
            },
          },
        };
        expect(() => enforceEffectDispatch(tampered, connectorPolicy, {
          verifier: AUTHENTICATOR, clock: value.clock,
        })).toThrow(/authentication/);
      }
      value.clock.set(begun.permit.payload.claim.expiresAt);
      expect(() => enforceEffectDispatch(begun.permit, connectorPolicy, {
        verifier: AUTHENTICATOR, clock: value.clock,
      })).toThrow(/fence expired/);
      value.clock.set(begun.permit.payload.executionStartedAt + 1);

      const uncertainReport = report(begun, null, "indeterminate", value.clock.now(), {
        delivery: `timeout:${begun.effect.id}`,
      });
      const uncertain = await recordEffectReceipt(value.db, { report: uncertainReport }, {
        tenantId: WORKSPACE, principalId: value.workerId, expectedRevision: begun.effect.revision,
        verifier: weakVerifier, clock: value.clock,
      });
      expect((await getEffect(value.db, begun.effect.id, WORKSPACE))?.status).toBe("indeterminate");
      value.clock.advance(1);
      const recoveredReport = report(begun, operation.operationId, "committed", value.clock.now(), {
        delivery: `lookup:${begun.effect.id}`,
        resolvesReceiptId: uncertain.id,
      });
      await recordEffectReceipt(value.db, { report: recoveredReport }, {
        tenantId: WORKSPACE, principalId: value.workerId, expectedRevision: begun.effect.revision + 1,
        verifier: strongVerifier, clock: value.clock,
      });
      expect(provider.operations.size).toBe(1);
      expect((await listEffectReceipts(value.db, { tenantId: WORKSPACE, effectId: begun.effect.id })))
        .toHaveLength(2);
      expect((await getEffect(value.db, begun.effect.id, WORKSPACE))?.status).toBe("committed");
    } finally {
      await value.close();
    }
  });

  test("filesystem and deployment policies reject confused paths, artifacts and environments", async () => {
    const value = await world();
    try {
      const filesystemPolicy = policy(
        "filesystem",
        ["operation", "path", "root", "targetBindingDigest"],
        ({ parameters, scope }) => parameters.operation === "delete" &&
          parameters.root === scope.root && parameters.path === scope.path &&
          parameters.targetBindingDigest === scope.targetBindingDigest &&
          typeof parameters.path === "string" && !parameters.path.includes("..") &&
          !parameters.path.startsWith("/") && scope.symlinkFree === true,
      );
      const safeDelete = await authorized(value, "filesystem", {
        operation: "delete",
        root: "workspace-root",
        path: "build/cache.bin",
        targetBindingDigest: `sha256:${A}`,
      }, {
        root: "workspace-root",
        path: "build/cache.bin",
        targetBindingDigest: `sha256:${A}`,
        symlinkFree: true,
      }, {});
      const deleteBegun = await begin(value, safeDelete, filesystemPolicy);
      for (const mutation of [
        { path: "../secrets" },
        { root: "other-root" },
        { targetBindingDigest: `sha256:${R}` },
      ]) {
        const tampered = {
          ...deleteBegun.permit,
          payload: {
            ...deleteBegun.permit.payload,
            request: {
              ...deleteBegun.permit.payload.request,
              parameters: { ...deleteBegun.permit.payload.request.parameters, ...mutation },
            },
          },
        };
        expect(() => enforceEffectDispatch(tampered, filesystemPolicy, {
          verifier: AUTHENTICATOR, clock: value.clock,
        })).toThrow(/authentication/);
      }
      const provider = new IdempotentProvider();
      const deleted = provider.apply(deleteBegun.permit, filesystemPolicy, value.clock.now());
      await recordEffectReceipt(value.db, { report: report(
        deleteBegun, deleted.operationId, "committed", value.clock.now(),
      ) }, {
        tenantId: WORKSPACE, principalId: value.workerId, expectedRevision: deleteBegun.effect.revision,
        verifier: strongVerifier, clock: value.clock,
      });

      const compensation = await proposeEffect(value.db, {
        tenantId: WORKSPACE,
        taskId: safeDelete.task.id,
        attemptId: safeDelete.attempt.id,
        request: request("filesystem", {
          operation: "restore",
          root: "workspace-root",
          path: "build/cache.bin",
          targetBindingDigest: `sha256:${A}`,
        }),
        compensationOfEffectId: deleteBegun.effect.id,
      }, { tenantId: WORKSPACE, principalId: value.workerId, clock: value.clock });
      expect(compensation.status).toBe("proposed");
      expect((await getEffect(value.db, deleteBegun.effect.id, WORKSPACE))?.status).toBe("committed");

      const deploymentPolicy = policy(
        "deployment",
        ["account", "artifactDigest", "environment"],
        ({ parameters, scope }) => parameters.account === scope.account &&
          parameters.artifactDigest === scope.artifactDigest &&
          parameters.environment === scope.environment,
      );
      const deployment = await authorized(value, "deployment", {
        account: "protected-account", artifactDigest: `sha256:${A}`, environment: "production",
      }, {
        account: "protected-account", artifactDigest: `sha256:${A}`, environment: "production",
      }, {});

      const foreignWorkspace = "other-workspace";
      const foreignPrincipal = await createPrincipal(value.db, {
        tenantId: foreignWorkspace, kind: "runtime", displayName: "Foreign runtime",
      }, { tenantId: foreignWorkspace, clock: value.clock });
      const foreignTask = await createCommitment(value.db, {
        title: "Foreign commitment",
      }, {
        workspaceId: foreignWorkspace,
        actor: "foreign-runtime",
        principalId: foreignPrincipal.id,
        clock: value.clock,
      });
      const foreignClaim = await acquireTaskClaim(value.db, foreignTask.id, {
        tenantId: foreignWorkspace,
        principalId: foreignPrincipal.id,
        leaseMs: 10_000,
        clock: value.clock,
      });
      await expect(beginEffectExecution(value.db, deployment.effect.id, {
        tenantId: WORKSPACE,
        principalId: value.workerId,
        expectedRevision: deployment.effect.revision,
        claimId: foreignClaim.id,
        fence: foreignClaim.fence,
        policy: deploymentPolicy,
        permitIssuer: AUTHENTICATOR,
        clock: value.clock,
      })).rejects.toThrow(/claim|attempt|execution binding/i);
      await expect(recordEffectApproval(value.db, {
        tenantId: foreignWorkspace,
        effectId: deployment.effect.id,
        decision: "approved",
      }, { tenantId: foreignWorkspace, principalId: foreignPrincipal.id, clock: value.clock }))
        .rejects.toThrow(/Effect not found/);

      const deployBegun = await begin(value, deployment, deploymentPolicy);
      for (const mutation of [
        { artifactDigest: `sha256:${R}` },
        { environment: "staging" },
        { account: "other-account" },
      ]) {
        const tampered = {
          ...deployBegun.permit,
          payload: {
            ...deployBegun.permit.payload,
            request: {
              ...deployBegun.permit.payload.request,
              parameters: { ...deployBegun.permit.payload.request.parameters, ...mutation },
            },
          },
        };
        expect(() => enforceEffectDispatch(tampered, deploymentPolicy, {
          verifier: AUTHENTICATOR, clock: value.clock,
        })).toThrow(/authentication/);
      }
      await expect(recordEffectReceipt(value.db, {
        report: { ...report(deployBegun, "provider-op:deployment", "committed", value.clock.now()), workspaceId: foreignWorkspace },
      }, {
        tenantId: WORKSPACE,
        principalId: value.workerId,
        expectedRevision: deployBegun.effect.revision,
        verifier: strongVerifier,
        clock: value.clock,
      })).rejects.toThrow(/workspace/);
    } finally {
      await value.close();
    }
  });

  test("approval races, crash boundaries, inspection, doctor and clock purity remain deterministic", async () => {
    const value = await world();
    try {
      const connectorPolicy = policy(
        "money",
        ["account", "amountMinor", "currency", "recipient"],
        ({ parameters, scope, limits }) => parameters.account === scope.account &&
          parameters.recipient === scope.recipient && Number(parameters.amountMinor) <= Number(limits.maxAmountMinor),
      );

      const expiring = await authorized(value, "money", {
        account: "protected-account", amountMinor: 50, currency: "EUR", recipient: "expiry",
      }, { account: "protected-account", recipient: "expiry" }, { maxAmountMinor: 50 });
      value.clock.set(expiring.approval.expiresAt!);
      await expect(beginEffectExecution(value.db, expiring.effect.id, {
        tenantId: WORKSPACE,
        principalId: value.workerId,
        expectedRevision: expiring.effect.revision,
        claimId: expiring.claim.id,
        fence: expiring.claim.fence,
        policy: connectorPolicy,
        permitIssuer: AUTHENTICATOR,
        clock: value.clock,
      })).rejects.toThrow(/expired/);
      expect((await getEffect(value.db, expiring.effect.id, WORKSPACE))?.status).toBe("authorized");

      const revoked = await authorized(value, "money", {
        account: "protected-account", amountMinor: 60, currency: "EUR", recipient: "revoked",
      }, { account: "protected-account", recipient: "revoked" }, { maxAmountMinor: 60 });
      value.clock.advance(1);
      await recordEffectApproval(value.db, {
        tenantId: WORKSPACE,
        effectId: revoked.effect.id,
        decision: "revoked",
        supersedesApprovalId: revoked.approval.id,
      }, {
        tenantId: WORKSPACE,
        principalId: value.approverId,
        authorityVerification: { level: "cryptographic", method: "eval-revocation", details: {} },
        clock: value.clock,
      });
      const withdrawn = await getEffect(value.db, revoked.effect.id, WORKSPACE);
      expect(withdrawn?.status).toBe("proposed");
      await expect(beginEffectExecution(value.db, revoked.effect.id, {
        tenantId: WORKSPACE,
        principalId: value.workerId,
        expectedRevision: withdrawn!.revision,
        claimId: revoked.claim.id,
        fence: revoked.claim.fence,
        policy: connectorPolicy,
        permitIssuer: AUTHENTICATOR,
        clock: value.clock,
      })).rejects.toThrow(/authorized/);

      value.clock.advance(1);
      const deniedEffect = await proposeEffect(value.db, {
        tenantId: WORKSPACE,
        taskId: revoked.task.id,
        attemptId: revoked.attempt.id,
        request: request("money", {
          account: "protected-account", amountMinor: 70, currency: "EUR", recipient: "denied",
        }),
      }, { tenantId: WORKSPACE, principalId: value.workerId, clock: value.clock });
      value.clock.advance(1);
      const denial = await recordEffectApproval(value.db, {
        tenantId: WORKSPACE,
        effectId: deniedEffect.id,
        decision: "denied",
      }, {
        tenantId: WORKSPACE,
        principalId: value.approverId,
        authorityVerification: { level: "cryptographic", method: "eval-denial", details: {} },
        clock: value.clock,
      });
      await expect(authorizeEffect(value.db, deniedEffect.id, denial.id, {
        tenantId: WORKSPACE,
        principalId: value.workerId,
        expectedRevision: deniedEffect.revision,
        clock: value.clock,
      })).rejects.toThrow(/approved decision/);

      const race = await authorized(value, "money", {
        account: "protected-account", amountMinor: 100, currency: "EUR", recipient: "alice",
      }, { account: "protected-account", recipient: "alice" }, { maxAmountMinor: 100 });
      const outcomes = await Promise.allSettled([
        begin(value, race, connectorPolicy),
        cancelEffect(value.db, race.effect.id, "operator cancellation", {
          tenantId: WORKSPACE,
          principalId: value.approverId,
          expectedRevision: race.effect.revision,
          clock: value.clock,
        }),
      ]);
      expect(outcomes.filter((item) => item.status === "fulfilled")).toHaveLength(1);
      const raceStatus = (await getEffect(value.db, race.effect.id, WORKSPACE))?.status;
      expect(raceStatus === "executing" || raceStatus === "cancelled").toBe(true);

      // Crash before intent: no effect and no provider call. Crash after the
      // durable executing boundary: recovery keeps the same dispatch identity.
      const provider = new IdempotentProvider();
      expect(provider.operations.size).toBe(0);
      const crash = await authorized(value, "money", {
        account: "protected-account", amountMinor: 200, currency: "EUR", recipient: "bob",
      }, { account: "protected-account", recipient: "bob" }, { maxAmountMinor: 200 });
      const crashBegun = await begin(value, crash, connectorPolicy);
      expect(provider.operations.size).toBe(0);
      const applied = provider.apply(crashBegun.permit, connectorPolicy, value.clock.now());
      expect(provider.operations.size).toBe(1);
      // Lost response and process restart: the exact permit retry is provider-
      // deduplicated, then lookup materializes one terminal receipt.
      expect(provider.apply(crashBegun.permit, connectorPolicy, value.clock.now())).toEqual(applied);
      const uncertainty = await recordEffectReceipt(value.db, {
        report: report(crashBegun, null, "indeterminate", value.clock.now(), {
          delivery: `crash-timeout:${crashBegun.effect.id}`,
        }),
      }, {
        tenantId: WORKSPACE, principalId: value.workerId, expectedRevision: crashBegun.effect.revision,
        verifier: weakVerifier, clock: value.clock,
      });
      value.clock.advance(1);
      const recovered = await recordEffectReceipt(value.db, {
        report: report(crashBegun, applied.operationId, "committed", value.clock.now(), {
          delivery: `crash-lookup:${crashBegun.effect.id}`,
          resolvesReceiptId: uncertainty.id,
        }),
      }, {
        tenantId: WORKSPACE, principalId: value.workerId,
        expectedRevision: crashBegun.effect.revision + 1,
        verifier: strongVerifier, clock: value.clock,
      });
      expect(provider.operations.size).toBe(1);
      const retry = await recordEffectReceipt(value.db, { report: recovered.report }, {
        tenantId: WORKSPACE, principalId: value.workerId,
        expectedRevision: crashBegun.effect.revision + 1,
        verifier: strongVerifier, clock: value.clock,
      });
      expect(retry.id).toBe(recovered.id);

      const snapshot = await inspectCommitment(value.db, crash.task.id, {
        workspaceId: WORKSPACE, clock: value.clock,
      });
      expect(snapshot?.effectReceipts.map((item) => item.id)).toEqual([uncertainty.id, recovered.id]);
      expect(await diagnoseStore(value.db, value.client, WORKSPACE)).toMatchObject({ ok: true, issues: [] });

      const productionRoots = ["tasq-schema/src", "tasq-extension-sdk/src", "tasq-service/src"];
      const packageRoot = join(import.meta.dir, "..");
      const violations: string[] = [];
      const visit = (path: string) => {
        for (const name of readdirSync(path)) {
          const child = join(path, name);
          if (statSync(child).isDirectory()) visit(child);
          else if (child.endsWith(".ts") && relative(packageRoot, child) !== "tasq-schema/src/clock.ts") {
            const source = readFileSync(child, "utf8");
            if (/Date\.now\(|new Date\(\s*\)|performance\.now\(|process\.hrtime|Bun\.nanoseconds/.test(source)) {
              violations.push(relative(packageRoot, child));
            }
          }
        }
      };
      for (const root of productionRoots) visit(join(packageRoot, root));
      expect(violations).toEqual([]);
    } finally {
      await value.close();
    }
  });
});
