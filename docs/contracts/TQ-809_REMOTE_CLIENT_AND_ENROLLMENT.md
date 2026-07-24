# TQ-809 — Remote client, CLI and enrollment

> **Status:** implemented and repository-certified — 2026-07-24
> **Public package status:** source candidate; not present in published `v0.3.0`
> **Deployable Server status:** repository-certified container candidate; not published
> **Decision:** `../decisions/ADR-010_REMOTE_CLIENT_AND_ENROLLMENT_BOUNDARY.md`
> **Machine certificate:** `TQ-809_REMOTE_CLIENT_CERTIFICATION.json`

## Outcome

Tasq now has one runtime-neutral remote TypeScript client, one remote CLI
profile workflow and one bounded enrollment ceremony over the existing
TQ-803/TQ-804 guard:

```ts
import { createRemoteTasq } from "@tasq-run/client";

const tasq = createRemoteTasq({
  endpoint: "https://server.example/",
  workspaceId: "operations/alpha",
  accessToken: () => process.env.TASQ_ACCESS_TOKEN!,
});

const page = await tasq.listCommitments({ limit: 20 });
```

The package is Fetch-only. It imports no Core, LibSQL, migration or authority
implementation. The Server remains central truth.

## CLI

Enrollment is explicit and does not reuse `--actor`:

```bash
export TASQ_ENROLLMENT_TOKEN='<one-use secret>'
tasq remote enroll \
  --endpoint https://server.example/ \
  --workspace operations/alpha \
  --profile machine-a

tasq remote list --profile machine-a --json
tasq remote events --profile machine-a --after-sequence 42 --json
tasq remote operations --profile machine-a --json
tasq remote call claim.acquire \
  --profile machine-a \
  --resource-kind commitment \
  --resource-id <commitment-id> \
  --input '{"durationMs":1800000}' \
  --idempotency-key run-42 \
  --request-id run-42-request \
  --json
```

`TASQ_HOME/remote/<profile>.json` is created atomically with mode `0600`
inside a `0700` directory. It contains an opaque bearer credential and must
not be committed, copied into a project descriptor or printed in support
artifacts. `remote status` redacts it.

`tasq remote logout` removes only that local file and reports
`serverCredentialRevoked: false`. An administrator must revoke the access
credential or its binding/grant separately. Removing a client never removes
Server workspace data.

## Enrollment and credential lifecycle

An administrator first provisions:

1. one authority principal;
2. one exact issuer/subject binding;
3. immutable permission definitions and live scoped grants;
4. one enrollment record bound to client kind, exact action upper bound,
   bootstrap expiry and access expiry.

Only the random enrollment token is returned. Its HMAC digest is persisted.
Redemption is a single authority-store transaction: verify live workspace,
principal and binding; reject expired/revoked/consumed enrollment; mark it
consumed; insert one access-credential digest; append bounded audit; commit;
return the raw access credential once.

The initial access token is opaque and verified through the same authority
store. A next-request lookup rejects expiry or revocation before the normal
ADR-004 guard. The guard then intersects token actions with live binding,
grant, delegation, eligibility and scope. Neither a token nor tool visibility
is sufficient authority.

Recovery and rotation are intentionally explicit:

- unused code lost: revoke it and create a replacement;
- response lost during enrollment: administrator inspects audit, revokes the
  created credential if present, then creates a new enrollment;
- device lost: revoke credential and, when needed, binding/grant;
- routine rotation: enroll replacement, verify it, revoke predecessor, remove
  predecessor profile.

Raw tokens never enter the database, audit or machine certificate.

## Remote client contract

The client exposes:

- bounded commitment list/get;
- exclusive event pages and an async polling stream;
- explicit `cursor_expired` with `oldestSequence`; recovery may not silently
  hide a retention gap;
- state-free registered operation discovery;
- mutation execution with exact resource, optional expected revision,
  portable input, mandatory idempotency key and stable request ID;
- typed server problems with retryability.

A transport failure never invents success. The caller repeats the exact
operation, idempotency key and request ID. TQ-804 returns the same durable
outcome or a typed semantic conflict.

## Acceptance evidence

Repository tests prove:

- two independently enrolled principals contend on the same claim and opaque
  resource, release them and let the loser acquire afterward;
- one response lost after commit is recovered by exact replay;
- revoking a grant denies the next read and mutation with an otherwise
  unexpired credential;
- REST and the official MCP client read identical commitments, events and
  exclusive cursors;
- one-use, expiry, enrollment revocation and access-credential revocation fail
  closed;
- malformed bearer text and actor labels never authenticate;
- CLI credentials are private, redacted from output and removable without
  deleting Server state;
- cursor retention gaps return HTTP 410 plus the oldest retained sequence.

## Honest boundary

TQ-807 now provides the daemon/container candidate, RS256 verifier, Core
operation adapter, hosted read-only Console and operator lifecycle described in
`TQ-807_DEPLOYABLE_SERVER.md`. Neither that image nor `@tasq-run/client` is in
the current `v0.3.0` release. Protected image publication and TQ-808 hostile
packaged certification remain.
