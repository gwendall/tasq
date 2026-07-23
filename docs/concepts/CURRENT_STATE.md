# Current state

**Updated:** 2026-07-23

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

Public source launch occurred on 2026-07-22 and protected public alpha
`v0.3.0` is the current release, published on 2026-07-23. TQ-607 private dogfood remains the
stable-graduation gate. The
minimum program spans 30 calendar days and three real consumers: the personal
life-pilot, Kami Robotics resource coordination and a Denshin-shaped or
equivalent interactive agent runtime. It requires retained-data upgrades,
backup/restore, crash recovery, cold onboarding and an explicit maintainer
`go`, `extend` or `no_go` decision. Early users may install `0.3.0`, build from
source and file issues while this retained-data gate continues.

The retained baseline and isolated restore are verified. Kami and the
interactive runtime have completed every required journey; cold onboarding,
support review and replacement-agent cursor recovery also pass. The personal
track has one real active-use day and one of three journeys, and one of two
same-ledger forward upgrades is complete. No critical failure is open. These
figures are a 2026-07-22 checkpoint only; `../contracts/TQ-607_DOGFOOD_STATUS.json` and
`pnpm --silent dogfood status --json` are the authoritative current state.

The Local release lifecycle is certified from exact published bytes. Generated
target assets can be verified and installed outside the checkout, upgraded,
paired with a matching snapshot for rollback, and uninstalled without touching
`TASQ_HOME`. The current assets are published at immutable `v0.3.0`. Protected run
[30051196124](https://github.com/gwendall/tasq/actions/runs/30051196124)
downloaded them, verified every attestation and passed the lifecycle on both
supported targets, closing TQ-604.

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
are certified without a checkout or hidden service; the same path now also
passes from exact `v0.3.0` published bytes on both supported targets.

TQ-605 adds a separate static public product and documentation application in
`apps/site`. It covers the human, agent, MCP, SDK and operator paths and derives
support/release status from the repository's machine contracts. The same exact
snapshot is exported at `/product-truth.json`. The app is deployed from public
`main` at <https://tasq.run>; it is neither the Local Console nor an
agent/ledger API. The Vercel project remains an implementation detail rather
than the public entrypoint.

TQ-606 adds the fail-closed `/adopt.json` pre-executable contract and a complete
candidate adoption journey across a human-shell proxy, a package-independent
agent, typed contention/recovery, evidence completion and installed same-ledger
Console inspection. The exact published-byte replay now passes on both targets.
One independent real-human blind session remains the sole external gate; no
human-usability completion is inferred from the automated proxy.

TQ-610's source implementation now provides two pinned no-install package
runners, a repository-owned versioned native lifecycle bootstrap, stable
`/SKILL.md`, `/agents`, `/llms.txt` and `/integration.json` entrypoints, exact
Codex/Claude/generic MCP registration recipes and a non-secret project
rendezvous schema that is never activated from cwd. The `v0.1.1` installer,
one-command human `setup`, isolated `demo` and deterministic `agent install`
helper are published and pass downloaded-byte certification on macOS ARM64
and Linux x64 GNU. These paths are `implemented_certified`. See
`../contracts/TQ-610_ACQUISITION_AND_AGENT_ENTRYPOINT.md`.

TQ-321 certifies integrations `0.1.1` and `0.1.2` on native Codex and Claude
Code. The TQ-610 `0.1.2` trial installed the public-`main` marketplace at
commit `bbab02d`, passed both host families with zero intervention and is bound
to the exact behavioral-evidence digest in
`../contracts/TQ-610_AGENT_ENTRYPOINT_CERTIFICATION.json`. Both host
marketplaces install the same versioned safety skill and the certified version passes
isolated clean-home install, two-process behavioral and uninstall trials. The
skill obtains an absent
executable through `/adopt.json`, requires an explicit space and stable actor,
uses already host-bound MCP when present and otherwise starts with CLI JSON
onboarding. It never mirrors a runtime scratchpad. Both blind agents read before
mutation, resumed the same attempt after restart, continued from an exclusive
event cursor, rejected stale resource authority, attached evidence, completed
explicitly and preserved the ledger byte-for-byte through native uninstall.
The exact machine certificate is `../../evidence/tq-321/latest.json`.

TQ-608 protects both release and source evolution. Published `v0.3.0` uses
store format 26. Each executable reports its exact read/write/direct-migration
ranges. Existing-store upgrades are serialized, snapshot-verified,
receipt-backed and post-checked; newer or ambiguous histories fail before
mutation. Real process-kill recovery and portable create-only workspace
round-trip pass on filesystem databases, and a real file-size quota fails
before schema mutation while retaining only a private diagnostic partial.
Exact `v0.3.0` published bytes now migrate the populated format-5 fixture and
pass post-migration doctor on both targets. Exact N-2 protected lines become a
mandatory boundary once three protected release lines exist; see
`../guides/DATA_SAFETY.md` and the TQ-608 certificate.

TQ-705 certifies the Local Console in real Chromium on both Linux and macOS.
Five fixed-clock, process-isolated ledgers cover empty, mature, hostile,
corrupt and 2,501-commitment states. Pagination stays bounded, hostile content
stays inert, support metadata stays redacted and corrupt canonical state fails
with a generic operator-safe error. This is a Local browser gate, not a hosted
Console or broad browser-engine claim.

TQ-320 now has package-independent and published-package certificates. A clean-room
runtime installs generated `@tasq-run/schema`, `@tasq-run/extension-sdk` and
`@tasq-run/core` tarballs, then proves assignment, stable conversation/run
identity, lost-response deduplication, `input_required` resume, claim expiry
and higher-fence reclaim, two attempts in one conversation, distinct
artifacts/evidence, cursor-only restart across separate adapter processes,
stale claim/fence rejection at the protected effect gate and explicit
completion. No new Core entity or runtime-specific enum was required. Local autonomous onboarding now
also advertises additive retry-safe attempt recipes and an exact audit-resume
recipe. Protected run 30051196124 replayed the same fixture from exact
`@tasq-run/*@0.3.0` registry tarballs on both targets, closing TQ-320. The
private Denshin journey remains separate product-learning evidence.

The same clean-room trial found and closed an Embedded Core packaging gap:
effects required a registered immutable type, but `@tasq-run/core` did not expose
the neutral administrative manifest installer. `installExtension` and the
read-only registry queries now live in Core; the Local service only adds
bundled compatibility provisioning. Manifest installation never loads code or
grants effect authority.

TQ-611 now provides the published `createLocalTasq` interface inside
`@tasq-run/core`. One explicit call owns store opening, checksum-pinned
migrations, coordination-space/principal bootstrap and repeated operation
context while keeping URL, workspace, actor and `Clock` mandatory. The
published `0.3.0` Core, Schema and Extension SDK packages contain compiled ESM
plus declarations and pass fresh Node 22 and Bun same-ledger restart tests
from exact registry tarballs. The CLI, MCP, Console and protocol adapters
remain Bun-only. Protected publication run
[30050429924](https://github.com/gwendall/tasq/actions/runs/30050429924)
and post-release certification run
[30051196124](https://github.com/gwendall/tasq/actions/runs/30051196124)
close the interface's release gate.
See `../contracts/TQ-611_EMBEDDED_TYPESCRIPT_CLIENT.md`.

TQ-612 is published and exact-byte certified in `v0.3.0`. ADR-005
freezes four evidence authenticity classes and separates immutable resolution
contracts, evidence trust/revocation, completion proposals, challenges,
validation decisions and final completion records. Deterministic, attested,
optimistic and adjudicated policies fail closed on stale criteria, evidence,
trust or evaluator identity. Core, `createLocalTasq`, CLI, local MCP,
inspection, Local Console, doctor and portable export/import share the same
records. Local CLI/MCP can claim only unverified attribution; higher trust
requires a host authority. Validated commitments are intentionally excluded
from replication until its protocol carries the entire resolution chain.
Publication run
[30050429924](https://github.com/gwendall/tasq/actions/runs/30050429924)
and post-release run
[30051196124](https://github.com/gwendall/tasq/actions/runs/30051196124)
certify both native targets and all seven registry tarballs. See
`../contracts/TQ-612_INDEPENDENT_COMPLETION_RESOLUTION.md`.

The shortest verified loop is:

```text
commitment → claim → attempt → evidence → explicit completion
```

Typed waits, observations, reconciliation, resource leases, effects,
replication, bounded context and audit history extend that loop without making
runtime success equivalent to commitment completion.

When independent validation is required, the longer explicit path is:

```text
evidence → trust → proposal → challenge? → validation decision → completion
```

Authority time is injectable throughout the kernel. Raw device time is allowed
only in the explicit `systemClock` composition adapter.

For orientation, read [README.md](../../README.md),
[DEVELOPMENT.md](../guides/DEVELOPMENT.md),
[PRODUCT_CONSUMPTION_SPEC.md](PRODUCT_CONSUMPTION_SPEC.md),
[UNIVERSAL_KERNEL_SPEC.md](UNIVERSAL_KERNEL_SPEC.md),
[BACKLOG.md](../roadmap/BACKLOG.md), [ARCHITECTURE.md](ARCHITECTURE.md) and
[SECURITY.md](../../SECURITY.md), then run `pnpm docs:check`, `pnpm typecheck` and
`pnpm test`.
