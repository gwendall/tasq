# Current state

**Updated:** 2026-07-22

Tasq currently ships source for two local product shapes:

- **Core:** an embeddable, profile-neutral coordination kernel;
- **Local:** the CLI, local stdio MCP transport and read-only loopback Console.

Server, remote MCP and Cloud are planned, not implemented. Host-integrated
read and registered-mutation REST handlers exist, but no deployable endpoint ships. Provider
connectors, domain policy and agent runtimes remain outside Core.

TQ-801 implements Server's first internal building block:
`@tasq-internal/authority` owns strict verified-identity, binding, principal,
permission, grant, delegation, eligibility, request and decision contracts;
16 exact action identities; and a pure deny-by-default evaluator. It consumes
one injected clock snapshot and has no transport, credential verification,
persistence, store routing or kernel dependency. Consequently it creates no
new human or agent entrypoint and does not change the `not_implemented` Server,
REST, remote MCP or hosted Console support claims.

TQ-802 is now also implemented internally. `@tasq-internal/server` persists
host/workspace routing, principals, issuer/subject bindings, immutable
permission definitions, live grants/delegations/eligibility, idempotency,
decisions and append-only security audit in a separate authority database.
Its router resolves only a host-configured opaque storage binding after an
allow, so a denied foreign-workspace probe invokes no domain-ledger opener.
TQ-803 wraps that boundary in a Fetch-compatible authenticated read handler.
It publishes RFC 9728 discovery, accepts identity only from a host-supplied
credential verifier, authorizes every request live, supports bounded
commitment reads and payload-free event metadata, and captures one injected
clock snapshot per request. It is an integration entrypoint, not a listener or
deployable Server; concrete OIDC/JWKS/introspection adapters are not yet
provided.

TQ-804 adds a public state-free operation catalog and host-integrated guarded
mutation handler. Every mutation requires caller-scoped durable idempotency,
one registered action and one injected request timestamp. The authority store
holds a `BEGIN IMMEDIATE` writer gate through the host's domain commit, so a
concurrent revocation cannot cross an admitted mutation. The separate
databases are honestly serialized rather than described as cross-database
ACID; a lost boundary returns typed unknown outcome and exact-retry recovery.
No bundled operation adapter, listener or deployable Server exists yet.

This is the public canonical source repository. `main` requires pull requests,
green macOS and Linux verification, conversation resolution and linear history;
deletion and non-fast-forward updates are blocked. `v*` tags are immutable,
the `release` environment accepts only `v*`, secret scanning and push protection
are enabled, and private vulnerability reporting is active. The repository contains seven intended
public package sources and private compatibility, example and eval workspaces.
A package is not available merely because its source exists here; npm
availability starts only after an explicitly authorized protected attested
release.

Public source launch occurred on 2026-07-22 as an explicitly bounded alpha.
TQ-607 private dogfood remains the package-release gate. The
minimum program spans 30 calendar days and three real consumers: the personal
life-pilot, Kami Robotics resource coordination and a Denshin-shaped or
equivalent interactive agent runtime. It requires retained-data upgrades,
backup/restore, crash recovery, cold onboarding and an explicit maintainer
`go`, `extend` or `no_go` decision. Early users may build from source and file
issues; package publication remains blocked during the gate.

The retained baseline and isolated restore are verified. Kami and the
interactive runtime have completed every required journey; cold onboarding,
support review and replacement-agent cursor recovery also pass. The personal
track has one real active-use day and one of three journeys, and one of two
same-ledger forward upgrades is complete. No critical failure is open. These
figures are a 2026-07-22 checkpoint only; `TQ-607_DOGFOOD_STATUS.json` and
`pnpm --silent dogfood status --json` are the authoritative current state.

The Local release lifecycle now exists as a certified candidate. Generated
target assets can be verified and installed outside the checkout, upgraded,
paired with a matching snapshot for rollback, and uninstalled without touching
`TASQ_HOME`. This is not yet a published-download claim; see
`TQ-604_LIFECYCLE_CERTIFICATION.md` for the remaining evidence gate.

The loopback Console has canonical TQ-701 overview, actor, claim, resource,
wait, effect, redacted audit and bounded operational-health JSON contracts.
TQ-702 adds lossless polling and SSE invalidation with exclusive cursors,
typed recovery, bounded backpressure and injected time/scheduling. TQ-703 now
provides the server-rendered responsive operator UI, live/stale presentation,
bounded filters, audit timeline and previewable redacted support artifact. The
original commitment graph remains available as a deep inspection surface.
TQ-704 now bundles that full surface into installed Local artifacts and adds a
versioned foreground-listener announcement plus proof-of-life `web status`
discovery. Candidate install, v1-to-v2 same-ledger upgrade, stop and uninstall
are certified without a checkout or hidden service; published-byte evidence
still depends on the first protected release.

TQ-605 adds a separate static public product and documentation application in
`apps/site`. It covers the human, agent, MCP, SDK and operator paths and derives
support/release status from the repository's machine contracts. The same exact
snapshot is exported at `/product-truth.json`. The app is repository-certified
but not deployed; it is neither the Local Console nor an agent/ledger API.

TQ-606 adds the fail-closed `/adopt.json` pre-executable contract and a complete
candidate adoption journey across a human-shell proxy, a package-independent
agent, typed contention/recovery, evidence completion and installed same-ledger
Console inspection. Published-byte replay and an independent real-human blind
session remain external gates; no human-usability completion is inferred from
the automated proxy.

TQ-321 now has a native integration candidate for Codex and Claude Code. Both
host marketplaces install the same versioned safety skill and pass isolated
clean-home install/list/uninstall smoke tests. The skill obtains an absent
executable through `/adopt.json`, requires an explicit space and stable actor,
uses already host-bound MCP when present and otherwise starts with CLI JSON
onboarding. It never mirrors a runtime scratchpad. Full blind behavioral
certification across both hosts remains open, so this is not yet a completed
host-support claim.

TQ-608 now implements the source data-safety candidate. Store format 25 and
its read/write/direct-migration ranges appear in executable and release
metadata. Existing-store upgrades are serialized, snapshot-verified,
receipt-backed and post-checked; newer or ambiguous histories fail before
mutation. Real process-kill recovery and portable create-only workspace
round-trip pass on filesystem databases, and a real file-size quota fails
before schema mutation while retaining only a private diagnostic partial.
Exact first protected release bytes and future N-2 protected lines remain
external replay boundaries; see `DATA_SAFETY.md` and the TQ-608 certificate.

TQ-705 certifies the Local Console in real Chromium on both Linux and macOS.
Five fixed-clock, process-isolated ledgers cover empty, mature, hostile,
corrupt and 2,501-commitment states. Pagination stays bounded, hostile content
stays inert, support metadata stays redacted and corrupt canonical state fails
with a generic operator-safe error. This is a Local browser gate, not a hosted
Console or broad browser-engine claim.

TQ-320 now has a package-independent candidate certificate. A clean-room
runtime installs generated `@tasq/schema`, `@tasq/extension-sdk` and
`@tasq/core` tarballs, then proves assignment, stable conversation/run
identity, lost-response deduplication, `input_required` resume, claim expiry
and higher-fence reclaim, two attempts in one conversation, distinct
artifacts/evidence, cursor-only restart across separate adapter processes,
stale claim/fence rejection at the protected effect gate and explicit
completion. No new Core entity or runtime-specific enum was required. Local autonomous onboarding now
also advertises additive retry-safe attempt recipes and an exact audit-resume
recipe. Final TQ-320 closure still requires replay from the first protected
published packages; the private Denshin journey remains product-learning
evidence rather than that external claim.

The same clean-room trial found and closed an Embedded Core packaging gap:
effects required a registered immutable type, but `@tasq/core` did not expose
the neutral administrative manifest installer. `installExtension` and the
read-only registry queries now live in Core; the Local service only adds
bundled compatibility provisioning. Manifest installation never loads code or
grants effect authority.

The shortest verified loop is:

```text
commitment → claim → attempt → evidence → explicit completion
```

Typed waits, observations, reconciliation, resource leases, effects,
replication, bounded context and audit history extend that loop without making
runtime success equivalent to commitment completion.

Authority time is injectable throughout the kernel. Raw device time is allowed
only in the explicit `systemClock` composition adapter.

For orientation, read [README.md](README.md),
[DEVELOPMENT.md](DEVELOPMENT.md),
[PRODUCT_CONSUMPTION_SPEC.md](PRODUCT_CONSUMPTION_SPEC.md),
[UNIVERSAL_KERNEL_SPEC.md](UNIVERSAL_KERNEL_SPEC.md),
[BACKLOG.md](BACKLOG.md), [ARCHITECTURE.md](ARCHITECTURE.md) and
[SECURITY.md](SECURITY.md), then run `pnpm docs:check`, `pnpm typecheck` and
`pnpm test`.
