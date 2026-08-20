import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  acceptReplicationPush,
  acknowledgeReplicationPush,
  buildReplicationPushRequest,
  createPrincipal,
  getCommitment,
  getReplicationSnapshot,
  initializeLocalReplica,
  initializeReplicationAuthority,
  installReplicationSnapshotAndRebase,
  openDb,
  prepareSignedStatementAcceptance,
  queueReplicatedCommitmentCreate,
  registerReplicationReplica,
  runKernelMigrations,
  SIGNED_STATEMENT_PURPOSES,
} from "@tasq-run/core";
import {
  ED25519_VERIFIER_IMPLEMENTATION_DIGEST,
  ED25519_STATEMENT_PROFILE_URI,
  signPurposeBoundStatement,
  verifyPurposeBoundStatement,
} from "@tasq-run/extension-sdk";
import { canonicalizeEffectJson, type SigningCredentialV1 } from "@tasq-run/schema";

const NOW = Date.parse("2026-08-13T14:30:00.000Z");
const WORKSPACE = "cert/tq806";
const AUDIENCE = "https://authority.tq806.clean-room.invalid/";
const PRINCIPAL_A = "agent:tq806-replica-a";
const PRINCIPAL_B = "agent:tq806-replica-b";
const AUTHORITY_REPLICA_ID = "019ffb80-0000-7000-8000-000000000001";
const AUTHORITY_EPOCH = "019ffb80-0000-7000-8000-000000000002";
const REPLICA_A_ID = "019ffb80-0000-7000-8000-000000000003";
const GENERATION_A_ID = "019ffb80-0000-7000-8000-000000000004";
const REPLICA_B_ID = "019ffb80-0000-7000-8000-000000000005";
const GENERATION_B_ID = "019ffb80-0000-7000-8000-000000000006";
const COMMITMENT_ID = "019ffb80-0000-7000-8000-000000000007";
const clock = { now: () => NOW };

function digest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256")
    .update(typeof value === "string" ? value : canonicalizeEffectJson(value as never))
    .digest("hex")}`;
}

async function json<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function output(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

async function opened(path: string) {
  const handle = await openDb({ url: `file:${path}`, wal: true });
  await runKernelMigrations(handle.client, { clock });
  return handle;
}

async function authorityInit(state: string, exchange: string): Promise<void> {
  const handle = await opened(join(state, "authority.sqlite"));
  try {
    const authority = await initializeReplicationAuthority(handle.db, {
      workspaceId: WORKSPACE,
      authorityReplicaId: AUTHORITY_REPLICA_ID,
      authorityEpoch: AUTHORITY_EPOCH,
      clock,
    });
    await createPrincipal(handle.db, {
      id: PRINCIPAL_A,
      tenantId: WORKSPACE,
      kind: "agent",
      displayName: "TQ-806 replica A",
      status: "enabled",
    }, { tenantId: WORKSPACE, actor: "clean-room-bootstrap", clock });
    await registerReplicationReplica(handle.db, {
      workspaceId: WORKSPACE,
      replicaId: REPLICA_A_ID,
      generationId: GENERATION_A_ID,
      principalId: PRINCIPAL_A,
      clock,
    });
    await registerReplicationReplica(handle.db, {
      workspaceId: WORKSPACE,
      replicaId: REPLICA_B_ID,
      generationId: GENERATION_B_ID,
      principalId: PRINCIPAL_B,
      clock,
    });
    await output(join(exchange, "authority-identity.json"), authority);
  } finally {
    await handle.close();
  }
}

async function replicaAPrepare(state: string, exchange: string): Promise<void> {
  const authority = await json<{
    authorityReplicaId: string;
    authorityEpoch: string;
  }>(join(exchange, "authority-identity.json"));
  const handle = await opened(join(state, "replica-a.sqlite"));
  try {
    await createPrincipal(handle.db, {
      id: PRINCIPAL_A,
      tenantId: WORKSPACE,
      kind: "agent",
      displayName: "TQ-806 replica A",
      status: "enabled",
    }, { tenantId: WORKSPACE, actor: "clean-room-bootstrap", clock });
    await initializeLocalReplica(handle.db, {
      workspaceId: WORKSPACE,
      replicaId: REPLICA_A_ID,
      generationId: GENERATION_A_ID,
      authorityReplicaId: authority.authorityReplicaId,
      authorityEpoch: authority.authorityEpoch,
      clock,
    });
    await queueReplicatedCommitmentCreate(handle.db, {
      id: COMMITMENT_ID,
      title: "TQ-806 clean-room replicated commitment",
      successCriteria: "Authority accepts an exact signed origin and replica B reads the snapshot",
    }, {
      workspaceId: WORKSPACE,
      actor: PRINCIPAL_A,
      principalId: PRINCIPAL_A,
      clock,
    });
    const request = await buildReplicationPushRequest(handle.db, WORKSPACE);
    const operation = request.operations[0]!;
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const publicMaterial = {
      format: "jwk-okp-ed25519" as const,
      x: publicKey.export({ format: "jwk" }).x!,
    };
    const credential: SigningCredentialV1 = {
      credentialId: "credential:tq806:replica-a",
      workspaceId: WORKSPACE,
      principalId: PRINCIPAL_A,
      profileUri: ED25519_STATEMENT_PROFILE_URI,
      profileVersion: 1,
      publicMaterial,
      publicMaterialDigest: digest(publicMaterial),
      trustRootDigest: digest("tq806-clean-room-root"),
      isolationClass: "isolated_process",
      status: "active",
      revision: 1,
      validFrom: new Date(NOW - 60_000).toISOString(),
      expiresAt: new Date(NOW + 3_600_000).toISOString(),
      enrollmentMethod: "clean-room-proof-of-possession",
      enrollmentEvidenceDigest: digest("tq806-clean-room-enrollment"),
    };
    const payload = {
      contractVersion: "tasq.signed-statement.v1" as const,
      statementId: "statement:tq806:replica-a:operation-1",
      workspaceId: WORKSPACE,
      audience: AUDIENCE,
      issuerPrincipalId: PRINCIPAL_A,
      credentialId: credential.credentialId,
      purpose: {
        uri: SIGNED_STATEMENT_PURPOSES.replication_operation_origin,
        version: 1,
      },
      subject: {
        typeUri: "https://schemas.tasq.dev/subjects/replication-operation/v1",
        id: operation.operationDigest,
        digest: operation.operationDigest as `sha256:${string}`,
      },
      nonce: "nonce:tq806:replica-a:operation-1",
      issuedAt: new Date(NOW).toISOString(),
      expiresAt: new Date(NOW + 3_600_000).toISOString(),
      metadata: {},
    };
    const bundle = await signPurposeBoundStatement(payload, {
      credentialId: credential.credentialId,
      profileUri: ED25519_STATEMENT_PROFILE_URI,
      profileVersion: 1,
      allowedPurposeUris: [SIGNED_STATEMENT_PURPOSES.replication_operation_origin],
      signStatement: ({ preAuthenticationEncoding }) =>
        sign(null, preAuthenticationEncoding, privateKey),
    });
    await output(join(exchange, "replica-a-push.json"), {
      request,
      bundle,
      credential,
      operationDigest: operation.operationDigest,
    });
  } finally {
    await handle.close();
  }
}

async function authorityAccept(state: string, exchange: string): Promise<void> {
  const input = await json<{
    request: Parameters<typeof acceptReplicationPush>[1];
    bundle: Parameters<typeof signPurposeBoundStatement>[0];
    credential: SigningCredentialV1;
    operationDigest: string;
  }>(join(exchange, "replica-a-push.json"));
  const handle = await opened(join(state, "authority.sqlite"));
  try {
    const prepared = await prepareSignedStatementAcceptance({
      bundle: input.bundle,
      expectedAudience: AUDIENCE,
      acceptedTrustRootDigests: [input.credential.trustRootDigest],
      binding: {
        bindingKind: "replication_operation_origin",
        recordType: "replication_operation",
        recordId: input.operationDigest,
        recordDigest: input.operationDigest as `sha256:${string}`,
      },
      verify: async (request) => ({
        ...await verifyPurposeBoundStatement({
          ...request,
          resolveCredential: (id) => id === input.credential.credentialId
            ? input.credential
            : null,
        }),
        verifierImplementationDigest: ED25519_VERIFIER_IMPLEMENTATION_DIGEST,
      }),
    }, { tenantId: WORKSPACE, actor: PRINCIPAL_A, principalId: PRINCIPAL_A, clock });

    const rejected: Record<string, string> = {};
    try {
      await acceptReplicationPush(handle.db, input.request, {
        authenticatedReplicaId: REPLICA_A_ID,
        authenticatedPrincipalId: PRINCIPAL_A,
        actor: PRINCIPAL_A,
        clock,
        signedOrigins: [],
      });
      throw new Error("unsigned push unexpectedly succeeded");
    } catch (error) {
      rejected.missingProof = error instanceof Error ? error.message : String(error);
    }
    try {
      await acceptReplicationPush(handle.db, input.request, {
        authenticatedReplicaId: REPLICA_A_ID,
        authenticatedPrincipalId: "agent:tq806:foreign",
        actor: "agent:tq806:foreign",
        clock,
        signedOrigins: [prepared],
      });
      throw new Error("foreign principal push unexpectedly succeeded");
    } catch (error) {
      rejected.foreignPrincipal = error instanceof Error ? error.message : String(error);
    }

    const response = await acceptReplicationPush(handle.db, input.request, {
      authenticatedReplicaId: REPLICA_A_ID,
      authenticatedPrincipalId: PRINCIPAL_A,
      actor: PRINCIPAL_A,
      clock,
      signedOrigins: [prepared],
    });
    const snapshot = await getReplicationSnapshot(handle.db, WORKSPACE);
    await output(join(exchange, "authority-result.json"), { response, snapshot, rejected });
  } finally {
    await handle.close();
  }
}

async function replicaAAcknowledge(state: string, exchange: string): Promise<void> {
  const { response } = await json<{ response: Parameters<typeof acknowledgeReplicationPush>[1] }>(
    join(exchange, "authority-result.json"),
  );
  const handle = await opened(join(state, "replica-a.sqlite"));
  try {
    await acknowledgeReplicationPush(handle.db, response, clock);
    await output(join(exchange, "replica-a-ack.json"), { acknowledged: true });
  } finally {
    await handle.close();
  }
}

async function replicaBInstall(state: string, exchange: string): Promise<void> {
  const authority = await json<{
    authorityReplicaId: string;
    authorityEpoch: string;
  }>(join(exchange, "authority-identity.json"));
  const { snapshot } = await json<{ snapshot: Parameters<typeof installReplicationSnapshotAndRebase>[1] }>(
    join(exchange, "authority-result.json"),
  );
  const handle = await opened(join(state, "replica-b.sqlite"));
  try {
    await initializeLocalReplica(handle.db, {
      workspaceId: WORKSPACE,
      replicaId: REPLICA_B_ID,
      generationId: GENERATION_B_ID,
      authorityReplicaId: authority.authorityReplicaId,
      authorityEpoch: authority.authorityEpoch,
      clock,
    });
    const installed = await installReplicationSnapshotAndRebase(handle.db, snapshot, {
      actor: PRINCIPAL_B,
      clock,
    });
    const commitment = await getCommitment(handle.db, COMMITMENT_ID, WORKSPACE);
    if (!commitment || commitment.title !== "TQ-806 clean-room replicated commitment") {
      throw new Error("replica B did not materialize the authority commitment");
    }
    await output(join(exchange, "replica-b-result.json"), {
      installed,
      commitment: {
        id: commitment.id,
        title: commitment.title,
        status: commitment.status,
      },
    });
  } finally {
    await handle.close();
  }
}

const [phase, state, exchange] = process.argv.slice(2);
if (!phase || !state || !exchange) throw new Error("usage: worker <phase> <state> <exchange>");

switch (phase) {
  case "authority-init": await authorityInit(state, exchange); break;
  case "replica-a-prepare": await replicaAPrepare(state, exchange); break;
  case "authority-accept": await authorityAccept(state, exchange); break;
  case "replica-a-ack": await replicaAAcknowledge(state, exchange); break;
  case "replica-b-install": await replicaBInstall(state, exchange); break;
  default: throw new Error(`unknown phase: ${phase}`);
}
