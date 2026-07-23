# ADR-004 / TQ-505 — Authenticated hosted tenancy

> **Status:** accepted design; TQ-801–TQ-804 internal foundations implemented — 2026-07-21
> **Implementation:** strict DTOs/evaluator plus the durable authority control
> plane, opaque ledger router and host-integrated read/mutation handlers exist;
> no deployable transport, concrete verifier or bundled domain adapter ships
> **Decision:** a hosted request crosses a transport authentication boundary,
> maps an immutable external subject to a workspace principal, passes a live
> deny-by-default authorization decision, and only then reaches the existing
> kernel. Authentication, attribution, authorization and effect approval stay
> distinct.

## 1. Problem and first principles

Tasq already isolates records by workspace, preserves stable principals,
coordinates concurrent work, replicates through one authority and guards
provider effects. It deliberately does not prove that a remote caller is the
principal it names. Exposing the current kernel directly over HTTP would turn
`--actor`, onboarding capabilities and client-supplied workspace IDs into a
confused-deputy vulnerability.

A hosted design must answer six questions independently for every request:

1. Which service endpoint and authority did the client intend to reach?
2. Which external subject proved possession of which credential?
3. Which Tasq workspace principal is bound to that subject?
4. Is another principal acting on behalf of that subject?
5. Which exact action on which exact resource is currently allowed?
6. Which immutable evidence lets an operator explain the decision later?

The answers cannot come from a task title, actor alias, role label, discovery
capability, assignment, claim, token scope alone or a successful remote Task.
The default is denial. No unauthenticated remote caller may create a workspace,
bind itself to a principal or widen a grant.

## 2. Boundaries that remain distinct

| Layer | Meaning | Never means |
|---|---|---|
| TLS / trusted proxy | Connection reached the configured host boundary | End-user identity or permission |
| Authentication adapter | A credential was validated for an issuer, subject and audience | Access to a workspace |
| Subject binding | `(issuer, subject)` maps to one principal in one workspace | A live permission |
| Authorization guard | One registered action/resource decision is allowed now | Effect approval or completion |
| Kernel | The already-validated domain command preserves Tasq invariants | Network policy or credential validation |
| Effect gate | Exact request, approval, fence, permit and receipt chain | General workspace administration |

The hosted adapter is a sibling of CLI, MCP and the inspector. It may depend
inward on a new pure authentication/authorization contract package and
`@tasq-run/core`. The kernel and service may not import HTTP, OIDC,
SPIFFE, cookies, an identity vendor or a policy engine.

```text
remote client
    |
    v
TLS / trusted proxy
    |
    v
credential verifier -> VerifiedIdentityV1
    |
    v
workspace router + subject binding
    |
    v
live authorization guard -> AuthorizationDecisionV1
    |
    v
existing Tasq kernel -> workspace store / effect gate
```

No network route may call the raw kernel before the guard. Embedded hosts that
intentionally call the kernel directly remain trusted compositions and must
not describe that path as authenticated remote access.

TQ-801 implements the pure `credential verifier output -> live decision`
contract in `@tasq-internal/authority`. TQ-802 supplies durable authority state
and isolated routing in `@tasq-internal/server`. TQ-803 adds the
Fetch-compatible read-only adapter and RFC 9728 discovery around those exact
boundaries. A host must still supply a conforming credential verifier,
workspace reader and listener. This changes REST-handler support to
integration-required; it does not ship Tasq Server, remote MCP or hosted web.
TQ-804 extends the adapter with host-registered mutation contracts and keeps a
live authority writer gate through each durable idempotent workspace callback.
Because authority and workspace ledgers remain separate, this is revocation
serialization plus exact unknown-outcome recovery, not cross-database ACID.

## 3. Canonical identity

### 3.1 External subject binding

Remote identity is the pair `(issuer, subject)`, never email, display name,
actor text or token-local username. The same subject can be a member of several
workspaces, and two issuers can reuse the same subject string without
collision. A workspace binding has:

- stable binding ID, workspace ID and principal ID;
- canonical HTTPS issuer URI and opaque subject;
- method class (`oidc`, `oauth_introspection`, `spiffe` or a future absolute
  extension URI);
- enabled/disabled status and monotone revision;
- creation, disablement and replacement audit identities;
- no access token, refresh token, private key, email or credential secret.

The binding is unique on `(workspaceId, issuer, subject)`. Disabling it blocks
new requests immediately even if a previously issued token has not expired.
Historical events retain their principal and decision references.

### 3.2 Subject and actor

The authenticated subject is the party whose authority is being used. The
actor is the workload actually making the request. Without delegation they are
the same principal. With delegation both must be preserved. OAuth token
exchange's `act` claim is one possible transport representation, not the
kernel model; see [RFC 8693](https://datatracker.ietf.org/doc/html/rfc8693).

A delegation chain never inherits more authority than the intersection of:

- the subject's live grants;
- the actor's live grants;
- the token's audience and upper-bound scopes;
- the exact delegated action/resource/time envelope.

Impersonation, where the actor disappears from audit, is not supported. A
client-provided `actor` string can remain a display label only after the host
binds it to the authenticated actor principal.

### 3.3 Verified identity envelope

The authentication adapter emits a strict `tasq.verified-identity.v1` value:

```text
issuer, subject, audience[]
authenticationMethod, authenticatedAt, expiresAt
clientId?                 # authenticated OAuth client when present
actorIssuer?, actorSubject?
credentialBinding         # none | dpop thumbprint | mTLS/SPIFFE identity
tokenIdDigest?            # digest only, never the credential
```

This envelope is produced only after signature or introspection validation,
exact issuer and audience checks, expiry/not-before checks, token-type checks
and sender proof where required. An OpenID Connect ID Token authenticates a
login ceremony; it is not accepted as a Tasq API access token. JWT access
tokens may follow [RFC 9068](https://datatracker.ietf.org/doc/html/rfc9068);
opaque tokens require authenticated introspection under
[RFC 7662](https://datatracker.ietf.org/doc/html/rfc7662).

## 4. Protocol profile

The first hosted adapter uses stable OAuth/OIDC specifications and the
[OAuth Security Best Current Practice](https://datatracker.ietf.org/doc/html/rfc9700).
It does not depend on one identity vendor or on a moving draft version.

- Protected resource metadata follows
  [RFC 9728](https://datatracker.ietf.org/doc/html/rfc9728).
- Authorization-server metadata follows
  [RFC 8414](https://datatracker.ietf.org/doc/html/rfc8414).
- Browser login uses Authorization Code with PKCE and exact redirect URIs;
  implicit and password grants are forbidden.
- Access tokens are audience-restricted to the exact Tasq resource under
  [RFC 8707](https://datatracker.ietf.org/doc/html/rfc8707).
- Public/headless clients may use the
  [Device Authorization Grant](https://datatracker.ietf.org/doc/html/rfc8628)
  only when the configured authorization server advertises it. The user must
  see and approve the workspace and requested upper-bound capabilities.
- Long-lived workloads use a configured workload identity adapter. SPIFFE is
  supported as an optional adapter because it attests workloads and rotates
  short-lived SVIDs; it does not solve human membership or authorization. See
  the [SPIFFE Workload API](https://spiffe.io/docs/latest/spiffe-specs/spiffe_workload_api/).
- Sender-constrained tokens with
  [DPoP](https://datatracker.ietf.org/doc/html/rfc9449) or mTLS are mandatory
  for administration, effect-approval eligibility, dispatch and durable
  workload sessions. A deployment may allow short-lived bearer tokens for
  read/propose access, but still performs a live grant check on every request.

The resource server pins allowed issuers per hosted tenant. It never accepts an
issuer discovered from an untrusted token. Unknown signing keys trigger one
bounded metadata/JWKS refresh and then fail closed. Key caches, token windows,
DPoP nonce/replay state and session expiry use the injected authority clock.
TLS termination is an external trusted transport boundary; Tasq code must not
read the device clock to duplicate its certificate decision.

Browser sessions use a backend-for-frontend cookie marked `Secure`,
`HttpOnly` and `SameSite`, with origin and CSRF validation on every mutation.
Tokens are not placed in browser storage or inspector HTML. The local
`tasq web` command remains loopback-only and unauthenticated; hosted UI is a
different composition.

## 5. Authorization model

### 5.1 Registered actions, not prose

Authorization actions are immutable absolute URIs registered with a version
and implementation digest. The initial families are:

```text
workspace.read, workspace.admin
commitment.read, commitment.propose, commitment.mutate
claim.coordinate, attempt.execute, evidence.append
resource.coordinate
collaboration.assign
effect.propose, effect.approval.record, effect.dispatch
replication.enroll, replication.push, replication.pull
```

TQ-801 freezes the exact internal action identities as
`urn:tasq:action:<name>`, version 1, each with an implementation digest.
Unknown or altered identities fail closed. `read`, `propose` and `coordinate`
in onboarding remain guidance capabilities and upper bounds; they are not
grants.

### 5.2 Grants and permission sets

An authorization grant is an authority-owned, revisioned record containing:

- workspace, grantor and grantee principals;
- immutable permission-set URI, version and digest;
- exact resource scope: whole workspace, one commitment or one opaque resource
  identity;
- optional injected-clock `notBefore` and exclusive `expiresAt`;
- active or revoked state, revision and append-only decision history;
- caller-scoped idempotency identity for creation/revocation.

Permission sets expand to registered actions through immutable definitions.
Names such as observer, contributor or coordinator are UI labels around pinned
definitions, not authority by themselves. V1 is allow-only with implicit deny:
there is no deny precedence language, wildcard action, regex resource selector
or arbitrary executable predicate in the ledger.

Workspace administrators can manage membership and ordinary grants but do not
implicitly become eligible effect approvers or dispatchers. Recording an
approval requires separate eligibility; dispatch is limited to authenticated
connector service identities and still requires the existing exact effect
approval, claim fence, permit and receipt chain. This preserves separation of
duties.

### 5.3 Decision contract

Every guarded call produces `tasq.authorization-decision.v1`:

```text
requestId, workspaceId, evaluatedAt
subjectPrincipalId, actorPrincipalId
actionUri, resourceKind, resourceId
decision                  # allow | deny
reasonCode
grantIds[], permissionSetDigests[]
policyImplementationDigest
requestDigest
```

The evaluator checks enabled subject/actor principals, live subject bindings,
live grants, delegation intersection, scope, token upper bounds and registered
action identity from one injected timestamp. It never calls a provider or
reads mutable actor prose.

Allowed authority-bearing mutations, all grant/binding changes, and security-
critical denials receive durable append-only audit records. Read access also
goes to the host security log with request/decision IDs; deployments may set
retention independently so the domain ledger does not become an HTTP log
warehouse. Raw credentials and sensitive token claims are never logged.

An external policy decision point such as Cedar, OPA or a Zanzibar-style
service may implement the evaluator later only if it returns this complete
decision contract, pins a policy/model digest and fails closed. The reference
v1 evaluator remains small and deterministic.

## 6. Hosted tenant and workspace isolation

The hosted account/organization is a control-plane **host tenant**. A Tasq
workspace is a coordination authority and domain isolation unit. They are not
the same concept even though the historical storage column is named
`tenant_id`.

- The control plane maps an opaque workspace ID to exactly one host tenant,
  configured issuers and storage binding.
- The requested host/path workspace is untrusted input until the authenticated
  subject binding and grant are checked.
- The reference hosted deployment uses one database per workspace plus a
  separate control-plane database. This makes a missing row filter insufficient
  to cross a workspace boundary.
- A future shared database requires a store with independently enforced row
  security and cross-workspace adversarial tests. It is not a supported LibSQL
  reference mode merely because rows contain `tenant_id`.
- Database filenames, URLs and credentials never derive directly from a
  caller-supplied workspace string.
- Hosted control-plane records, credentials, sessions and billing data are not
  kernel records and are not replicated through TQ-405.

Within a workspace, every existing service query continues to filter by
workspace and every relationship remains workspace-checked. Store routing is
defense in depth, not a replacement for domain constraints.

## 7. Remote onboarding

The irreducible remote pointer is:

```text
Tasq coordination is at <HTTPS base URL> in workspace <explicit workspace ID>;
discover authentication through its protected-resource metadata.
```

The resource metadata is public and contains no workspace state. An
unauthenticated workspace request returns `401`, a standards-compliant
`WWW-Authenticate` challenge and a typed next action. After authentication,
the hosted onboarding response derives actor/principal from the verified
identity, reports the effective authorization subset and returns only recipes
or protocol operations within it.

Remote cold start cannot manufacture its own trust anchor. A human may approve
a device flow or invitation; a workload may already possess an attested
identity; an administrator may pre-provision a binding. If none exists, the
honest result is `authentication_required` or `membership_required`, not
self-service privilege escalation. Workspace creation likewise requires a
host-level authenticated grant and is separate from local empty-home creation.

REST and remote MCP use the same authentication middleware, workspace router,
authorization guard and decision IDs. Surface switching cannot widen access.
Discovery compatibility remains separate from authentication and permission.

## 8. Revocation, rotation and recovery

- Disabling a principal or subject binding and revoking a grant take effect on
  the next request even when a token is still valid.
- Issuer configuration and permission-set activation are revisioned. A stale
  administrator write fails compare-and-swap.
- Signing-key rotation accepts only keys reached from the pinned issuer's
  authenticated metadata. Unknown or revoked keys never downgrade to actor
  text or a cached self-assertion.
- Previously accepted domain events retain the decision, issuer and key
  thumbprint digests that were valid at acceptance. Revocation blocks future
  work; it does not rewrite history.
- Replication enrollment/push is authority-required and checks live identity
  and grant state. Accepted operation order remains ADR-003 authority order,
  never token time or device time.
- Authority epoch recovery and identity-key rotation are independent. Neither
  silently performs the other.
- Break-glass recovery is a distinct local operator procedure requiring
  explicit reason, two-party policy where configured and an immutable audit
  record. No remote token can grant itself break-glass scope.

## 9. Clock invariant

One host-injected `Clock` snapshot is captured per request and is passed to:

- token expiry/not-before and configured skew validation;
- session, device-flow, DPoP replay and metadata-cache decisions;
- binding/grant/delegation validity;
- authorization decision and domain mutation;
- HTTP `Date` and audit timestamps.

No hosted Tasq source may call `Date.now()`, construct a zero-argument `Date`,
read SQL time or compare provider timestamps for authority. Test adapters can
freeze, advance and rewind time without changing authorization ordering.
External TLS termination is trusted input and remains outside Tasq's clock;
the adapter records that boundary instead of pretending to reproduce it.

## 10. Threats and mandatory failure behavior

| Threat | Required behavior |
|---|---|
| Token for workspace A is sent to B | deny before any B store read |
| Same `sub` from another issuer | distinct identity; no binding reuse |
| Disabled binding with unexpired token | immediate deny |
| Stolen bearer token on privileged route | privileged routes require sender proof |
| Agent claims a human actor label | server-derived actor wins; spoof is audited/denied |
| Delegated agent exceeds human or actor grant | intersection denies |
| Token scope says admin but live grant does not | live grant denies |
| Assignment role says approver | no authority; separate eligibility required |
| Admin tries to dispatch an effect | deny unless authenticated connector identity and exact effect gate pass |
| Unknown `kid` or metadata outage | one bounded refresh, then fail closed |
| Grant revoked during concurrent mutation | authorization and mutation preconditions commit atomically or retry/deny |
| Client changes workspace after authentication | binding and store route mismatch deny |
| Device clock jumps | no decision change unless injected clock changes |
| Remote surface omits auth middleware | route-conformance test fails; raw kernel is unreachable |
| Cross-workspace error probes IDs | same non-enumerating not-found/denied contract |

Critical failures are non-compensable: cross-workspace disclosure, authority
widening, effect dispatch without the exact gate, unauthenticated mutation,
credential logging and device-clock authority fail the entire release.

## 11. Alternatives evaluated

| Alternative | Decision |
|---|---|
| Build a Tasq identity provider | Rejected. Identity proof, MFA and recovery are not commitment-ledger primitives. |
| Static API keys as principal identity | Rejected as the universal baseline: weak delegation, audience and lifecycle semantics. May exist only as a constrained host adapter. |
| Trust OAuth scopes as authorization | Rejected. Tokens can outlive membership changes and scopes are coarse upper bounds. Live grants remain authoritative. |
| Pure workspace RBAC | Rejected as the authority model. Permission sets may offer RBAC ergonomics, but exact actions/resources and separation of duty are retained. |
| Arbitrary ABAC/Cedar/OPA expressions in kernel rows | Rejected. This imports executable policy and non-portable context into the kernel. External PDP adapters are allowed behind the decision contract. |
| Embed Zanzibar/OpenFGA in Tasq | Rejected for v1. Relationship authorization is powerful, but it is a separate system with consistency and model-version operations. The design keeps a future adapter seam. Google's [Zanzibar paper](https://research.google/pubs/zanzibar-googles-consistent-global-authorization-system/) and OpenFGA's [immutable model guidance](https://openfga.dev/docs/getting-started/immutable-models) motivate pinned model digests rather than a home-grown graph engine. |
| SPIFFE for every identity | Rejected. It is excellent workload attestation but does not provide human login, membership or product authorization. |
| SCIM as authentication | Rejected. [SCIM](https://datatracker.ietf.org/doc/html/rfc7644) provisions users/groups and explicitly relies on separate authentication and access policy. It may become a host provisioning adapter later. |
| Attenuated capability tokens/macaroons | Deferred. They could improve disconnected delegation, but revocation, recovery and effect separation require a dedicated ADR and adversarial gate. |
| Shared LibSQL with application-only filters | Rejected for the reference host because one missed predicate can disclose another workspace. |

## 12. Implementation sequence authorized by this ADR

This ADR authorizes later implementation; it does not claim those surfaces
exist.

1. **Completed by TQ-801:** freeze strict identity, binding, grant,
   permission-set and decision DTOs,
   plus a pure injected-clock evaluator and threat vectors.
2. **Completed by TQ-802:** add authority-owned migrations and append-only
   security audit for bindings, grants and permission-set activation, plus the
   isolated opaque workspace router.
3. **Completed by TQ-803:** add a host-integrated read-only authenticated HTTP
   adapter with RFC 9728 discovery, bounded reads and event metadata.
4. **Completed in part by TQ-804:** add registered guarded mutation REST,
   durable idempotency, immediate revocation serialization and unknown-outcome
   recovery. Browser BFF sessions remain later work.
5. Add headless device/workload onboarding and remote MCP over the same guard.
6. Add replication enrollment/push authorization and hostile multi-workspace
   recovery tests.
7. Expose remote effect proposal/approval/dispatch only after separation-of-
   duty and sender-constrained credential tests pass.
8. Consider SCIM, SPIFFE federation or an external PDP only as optional host
   adapters with their own conformance suites.

Each slice requires release-artifact tests on Linux/macOS, two identity issuers,
human and workload clients, CLI/REST/MCP surface equivalence, cross-workspace
probes, revocation/key rotation, concurrency, crash recovery, hostile clocks
and retained blind-agent receipts. `../contracts/HOSTED_TENANCY_ACCEPTANCE.json` freezes the
matrix without pretending it has passed.

## 13. Deliberate non-claims

The accepted design and completed TQ-801–TQ-804 slices do not ship:

- a hosted Tasq service, deployable REST endpoint, remote MCP route or hosted
  inspector;
- an identity provider, token issuer, SCIM server or credential store;
- remote binding/grant administration APIs or browser sessions;
- multi-workspace shared-database isolation;
- authenticated effect or approval endpoints;
- ADR-005 evidence trust and high-stakes automatic completion.

Discovery may advertise only the host-integrated operations actually
registered by the composition. It must not advertise a deployable Server,
remote MCP, hosted web or any absent operation.
