# ADR-007 — MCP Tasks and A2A execution adapters

> **Status:** accepted — 2026-07-15  
> **Decision scope:** UK-010  
> **Protocol pins:** MCP `2025-11-25` Tasks; A2A `1.0` data model  
> **Depends on:** UK-006 collaboration records, UK-009 machine discovery  
> **Does not authorize:** remote calls, authentication, task cancellation,
> effect execution, evidence promotion or commitment completion

## 1. Decision

MCP Tasks and A2A Tasks are remote execution lifecycles. They map to Tasq
`attempt` records, not to commitments. Their stable remote identities map to
`external_ref`; output snapshots map to immutable `artifact` records.

No protocol status, result or artifact is evidence by itself. In particular,
`completed` maps only to attempt `succeeded`. A separate authorized actor must
bind an artifact or observation as evidence and complete the commitment under
its completion policy.

The implementation lives in the standalone
`@tasq/protocol-adapters` package. Dependency direction is one-way:

```text
MCP / A2A untrusted DTO
          │
          ▼
tasq-protocol-adapters ──▶ tasq-service/kernel ──▶ ledger

kernel/service/schema never import protocol adapters
```

## 2. Why both protocols need the same boundary

MCP Tasks `2025-11-25` are experimental durable handles around an asynchronous
request. The receiver owns task identity and the requestor polls for status and
result. The normative lifecycle is `working ↔ input_required`, then immutable
`completed`, `failed` or `cancelled`.

A2A 1.0 Tasks are server-generated execution objects inside an optional
context. They add `submitted`, `auth_required`, `rejected` and first-class
Artifacts. A2A explicitly separates Messages from output Artifacts.

Both describe *how one invocation is progressing*. Tasq commitments describe
*what outcome remains owed*. Treating either remote Task as the commitment
would make a provider/runtime lifecycle authoritative over durable shared
intent and would reintroduce dual-source-of-truth ambiguity.

Official references:

- <https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks>
- <https://github.com/modelcontextprotocol/ext-tasks>
- <https://a2a-protocol.org/latest/specification>
- <https://github.com/a2aproject/A2A/blob/main/specification/a2a.proto>

## 3. Status mapping

| Protocol state | Tasq attempt state | Rule |
|---|---|---|
| MCP `working` | `running` | Initial or resumed execution |
| MCP `input_required` | `input_required` | Input is coordination, never commitment blocking by itself |
| MCP `completed` | `succeeded` | Does not complete the commitment |
| MCP `failed` | `failed` | Terminal and immutable |
| MCP `cancelled` | `cancelled` | Terminal and immutable |
| A2A `TASK_STATE_SUBMITTED` | `running` | Accepted but not yet active |
| A2A `TASK_STATE_WORKING` | `running` | Active execution |
| A2A `TASK_STATE_INPUT_REQUIRED` | `input_required` | More user/agent input is required |
| A2A `TASK_STATE_AUTH_REQUIRED` | `input_required` | Auth remains a transport/runtime concern |
| A2A `TASK_STATE_COMPLETED` | `succeeded` | Does not complete the commitment |
| A2A `TASK_STATE_FAILED` | `failed` | Terminal and immutable |
| A2A `TASK_STATE_REJECTED` | `failed` | Refusal is a failed execution, not a cancelled commitment |
| A2A `TASK_STATE_CANCELED` | `cancelled` | Terminal and immutable |

`TASK_STATE_UNSPECIFIED` and unknown states are rejected. A remote terminal
state cannot be resurrected. A later contradictory terminal snapshot fails
closed. Out-of-order snapshots cannot move local state backward.

## 4. Identity and replay

Each adapter invocation includes:

- the local `commitmentId`;
- the authenticated local principal/actor attribution;
- a protocol task snapshot with a bounded remote ID;
- an injected clock used for every local timestamp and for missing optional
  remote timestamps;
- an adapter namespace identifying the remote system/endpoint without
  credentials.

The stable import identity is protocol + remote-system URI + remote task ID.
Attempt creation, external-reference append and artifact append use derived
idempotency keys. Replaying the same snapshot returns the existing records.
Reusing an identity with a different commitment, protocol or immutable content
is an error rather than a silent remap.

The connector must use one stable local actor/principal identity for that
import namespace across worker restarts. A rotated worker session may reuse the
connector principal; changing attribution for an existing idempotency identity
fails closed instead of rewriting provenance.

A2A `contextId` is retained on the attempt and as external-reference metadata.
MCP TTL and poll hints are advisory metadata only; Tasq does not become their
scheduler or garbage collector.

## 5. Artifact handling

MCP results and A2A Artifacts are untrusted protocol payloads. The adapter:

1. validates and bounds the protocol object;
2. canonicalizes the complete result/artifact snapshot;
3. computes its SHA-256 digest;
4. stores a small snapshot as a `data:` URI, or requires the connector to
   supply a digest-matching external content URI for a larger snapshot;
5. appends an immutable Tasq artifact linked to the attempt;
6. appends the protocol artifact/result identity as an external reference.

While the remote task is non-terminal, an updated A2A artifact with the same
remote ID and a new digest becomes a new Tasq artifact revision. Once the
attempt is terminal, a previously unseen final artifact may still be fetched,
but changing the digest of an already imported artifact identity fails closed.
Existing artifact rows are never rewritten. The adapter does not fetch URLs,
decode arbitrary files, trust media types, execute payloads or promote
artifacts to evidence.

## 6. Time and ordering

Raw device time is forbidden. All local time comes from an injected `Clock`.
Remote ISO timestamps are parsed as untrusted inputs, validated as non-negative
unix milliseconds and recorded only as protocol occurrence time.

MCP provides creation/update timestamps. A2A status timestamp is optional, so
the injected observation time is used when absent. Timestamp equality is
allowed for duplicate snapshots; an earlier state-changing snapshot is
rejected. Timestamp order does not grant authority and cannot override terminal
immutability.

## 7. Security and authority

- Protocol inputs are size-bounded before durable mutation.
- Unknown fields are ignored for forward compatibility; known fields are
  strictly typed and bounded.
- Remote endpoint credentials and auth tokens are never accepted or stored.
- `auth_required` is an execution interruption, not permission to acquire auth.
- Remote URLs remain untrusted references and are never fetched by the adapter.
- Adapter attribution proves who imported a snapshot, not that the remote claim
  is authentic. The hosting connector owns authentication and verification.
- Capability discovery and protocol compatibility never confer authorization.

## 8. Acceptance gate

UK-010 is complete only when executable tests prove:

1. every official MCP and A2A state has the exact mapping above;
2. unknown, oversized, malformed and out-of-order snapshots fail closed;
3. duplicate delivery creates one attempt/reference/artifact identity;
4. two different remote systems may reuse the same task ID without collision;
5. terminal attempts cannot be contradicted or resurrected;
6. small content is digest-bound inline and large content requires a matching
   externalized URI/digest;
7. A2A artifact updates append immutable revisions;
8. all timestamps use remote values or an injected clock, never device time;
9. kernel packages contain no MCP/A2A dependency or protocol state vocabulary;
10. completed MCP and A2A executions, including artifacts, leave the commitment
    open until a separate explicit evidence/completion decision.

UK-011 subsequently composed these adapters with UK-009 discovery and proved
two unfamiliar runtimes can cold-start, coordinate, disconnect and resume; see
`packages/tasq-evals/universal-kernel-acceptance.test.ts`.
