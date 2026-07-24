# TQ-805 — Authenticated remote MCP

> **Status:** implemented and repository-certified — 2026-07-24
> **Deployable Server status:** implemented as the unpublished TQ-807 source
> candidate
> **Machine certificate:** `TQ-805_REMOTE_MCP_CERTIFICATION.json`

## Outcome

Tasq Server exposes a host-integrated MCP Streamable HTTP adapter over the
same registered read and mutation operations as TQ-803/TQ-804. MCP is a
transport adapter, not another authority or domain implementation.

The first adapter is deliberately stateless and request/response only:

```text
POST /v1/workspaces/{explicit-workspace}/mcp
Authorization: Bearer …
```

The host still supplies the credential verifier, isolated workspace router,
registered operations and injected clock. TQ-807 remains responsible for a
listener, concrete verifier, configuration and deployable Server artifact.

## One authority seam

Every MCP HTTP request is authenticated for the exact Server audience and MCP
URL before JSON-RPC dispatch. The verified identity, not the raw credential,
enters the tool handler. Every tool then projects onto the existing
TQ-803/TQ-804 Fetch handler, so live subject binding, grants, workspace
routing, decision audit, mutation idempotency and revocation serialization
have one implementation.

The adapter may not:

- call a workspace or Core method directly;
- derive authority from MCP tool presence, annotations or client arguments;
- accept a workspace, actor, action URI or principal from tool input;
- turn OAuth scopes into live grants;
- retain raw bearer or DPoP material inside a tool callback.

One injected clock snapshot covers credential verification, authorization and
the projected operation for each MCP HTTP request.

## Surface

Authenticated clients receive:

- `tasq_commitment_list`;
- `tasq_commitment_get`;
- `tasq_event_list`;
- `tasq_operation_list`;
- one deterministic tool for each registered TQ-804 mutation operation.

Operation tools accept the same resource, expected revision, portable input
and mandatory idempotency key as REST. Their structured result contains the
same TQ-804 response, including decision ID, authority revision and replay
state. Normalizing an operation ID into a tool name must be collision-free or
server construction fails.

The state-free operation catalog remains discoverable, but tool visibility is
not permission. A live decision is made on every call. Switching from REST to
MCP cannot widen a subject's authority.

## Protocol and lifecycle

- MCP protocol framing uses the repository-pinned official SDK.
- V1 uses stateless Streamable HTTP JSON responses.
- GET/SSE, resumable MCP sessions and server-initiated notifications are not
  claimed; Tasq event cursors remain the durable resume mechanism.
- Each request constructs an isolated MCP server/transport pair and retains no
  process-local session authority.
- Missing or invalid credentials fail at HTTP before any MCP method or
  workspace opener runs.
- MCP tool errors return bounded structured problems without stack traces or
  credentials.

## Acceptance

Repository tests and an independent eval must prove:

1. the official MCP client initializes and discovers exact registered tools;
2. a read produces the same domain payload and registered action as REST;
3. a mutation produces the same result and durable replay as REST;
4. the same idempotency key with a different semantic request fails;
5. a revoked grant denies the next MCP call despite an unexpired token;
6. a foreign workspace probe opens no workspace storage;
7. REST and MCP decisions use the same action identity, router and policy
   implementation digest;
8. malformed JSON-RPC, credentials, paths and operation/tool collisions fail
   closed;
9. one request-wide injected time reaches verification and authorization;
10. no raw credential appears in results, decisions, audit or errors.

Until those gates pass, `remote_mcp` remains `not_implemented`.
