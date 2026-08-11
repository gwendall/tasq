# Current state

**Updated:** 2026-08-11

Tasq currently ships source for two local product shapes:

- **Core:** an embeddable, profile-neutral coordination kernel;
- **Local:** the CLI, local stdio MCP transport and read-only loopback Console.

Server now has a repository-certified daemon and Linux container candidate.
Cloud now has a private, provider-neutral control-plane and same-origin BFF
source candidate. Server composes guarded REST, stateless remote MCP, one-use
enrollment, real Core operations and an authenticated Console with a small
TQ-811 guarded human action surface. Cloud adds isolated provisioning,
sessions, identity lifecycle, quota, export/delete, backup/restore, opaque
credential-reference rotation and operations records around that Server
contract. No immutable public Server image, managed Cloud deployment or public
remote endpoint ships yet.
Provider connectors, domain policy and agent runtimes remain outside Core.

TQ-621 adds a public, source-linked comparison of same-backlog behavior across
Tasq, Claude Code, GitHub Copilot, Codex, Cursor, MCP and A2A. It does not turn
source candidates into shipped features: the comparison is pinned to Tasq
Local `v0.3.0`, explicitly same-machine, and labels classifications inferred
from first-party or normative sources. The defensible boundary is durable,
runtime-neutral commitment, claim, attempt, evidence and decision state — not
parallel execution, worktree isolation or vendor-native subagent orchestration.

TQ-623 deepens the local embedded Interface without adding Kernel state.
`createLocalTasq` now exposes existing assignment, artifact, external-reference
and effect services and composes atomic claim/start and outcome-submission
journeys. Nested services reuse one root writer transaction and defer external
audit mirroring until commit, so late failure leaves no partial rows or phantom
journal events. This is source-certified for Node and Bun candidate packages;
it does not claim Kernel/remote custody or remote provider execution. TQ-625
adds embedded provider-neutral attestations. TQ-626 adds a private Server
Mandates Module. TQ-627 adds embedded exact multi-party agreements as described
below.

TQ-627 stores immutable offers, exact per-party acceptances, termination and
activation. The final acceptance transactionally compiles reciprocal
obligations into existing evidence commitments and TQ-612 resolution
contracts. Accepted amendments cancel prior non-terminal obligations while
preserving every historical record. Assignment acceptance is explicitly not
agreement consent, and agreement acceptance grants no effect authority.

TQ-628 adds immutable settlement and recourse decisions over exact agreement,
commitment, attempt, validation and effect snapshots. Versioned policy rules
materialize new evidence commitments and optionally ordinary proposed effects
in one transaction. They never rewrite completion or grant effect authority;
post-dispatch correction is new recourse, not supersession.

TQ-629 adds a private reference delegated-action Runner and derived Review
Inbox outside Core. Durable outbox leases survive process restart; an exact
effect permit must cross a live claim/fence callback at the connector boundary;
persisted executing or indeterminate effects use provider lookup before any
new action. Settlement/recourse materialization reuses the Core exactly-once
boundary. The inbox re-reads assignments, agreements, injected eligibility,
attempts, evidence resolution, effects, settlements, overdue recourse and
experimental custody attention without a shadow store. This is source
architecture, not a managed runtime, provider-supply or remote-effect claim.

TQ-630 adds private Evidence Capture and Outcome Bundle Modules. A frozen
capture session binds the exact commitment revision, attempt, target,
resolution criterion, source and byte/media limits. Finalization hashes bytes,
checks the immutable store acknowledgement and appends Artifact plus Evidence
atomically after a live binding re-read. Outcome bundles are deterministic
content-addressed projections of exact Core records with required external
authority, custody and raw-byte references or omission disclosures. Their
signatures authenticate bytes only; they do not prove truth or grant authority.

TQ-631 adds a private experimental Custody Module outside Core. It stores one
immutable root per exact TQ-622 target, bilateral offer/accept/refuse handoffs,
one database-elected successor per source state and append-only incidents.
Parcel, equipment and cryptographic-control tests prove exact condition and
evidence binding, concurrent-successor exclusion, retry, expiry, immutable
history and create-only portable import. The recorded lineage explicitly does
not prove physical possession or grant ownership, access or effect authority.
ADR-017 graduates the design to a shared experimental Module only; Kernel,
remote product and public distribution support remain unchanged.

TQ-632 composes the delegated-action Interfaces into a private
`physical-verification/property-exterior@1` reference Profile and one
cross-domain certifier. Six scenarios—physical verification, remote hands,
software deployment, procurement, custody and a compromised agent—share exact
target, authority, execution, validation, recovery and portability invariants.
The hostile matrix denies target drift, revoked/denied routing, no-access,
partial/timeout completion, self-review and concurrent custody successors. One
end-to-end profile run proves restart replay, independent review and Core plus
custody import. Support is `reference_only`: there is still no worker supply,
provider availability, site access, identity proof, payment execution, hosted
Profile or remote-effect enablement.

TQ-617 now has a source candidate for explicit mid-task discovery capture.
`tasq capture` atomically creates one follow-up, records bounded machine
context and links it `discovered_from` the exact source commitment without
changing that commitment's claim. Failed task-targeted CLI commands print an
executable, shell-quoted capture recipe without copying original arguments or
error text. The provenance edge lives only in the universal relation graph,
is non-blocking and adds no store migration. Capture remains local and explicit;
it is not exposed through MCP, REST or a background runtime. TQ-608's protected
v0.4 release gate remains a dependency, so this is not yet a shipped claim.

TQ-801 implements Server's first internal building block:
`@tasq-internal/authority` owns strict verified-identity, binding, principal,
permission, grant, delegation, eligibility, request and decision contracts;
19 exact action identities, including separate evidence-trust, completion proposal and decision
authority; and a pure deny-by-default evaluator. It consumes
one injected clock snapshot and has no transport, credential verification,
persistence, store routing or kernel dependency. Consequently it creates no
new human or agent entrypoint by itself. At the historical TQ-801 boundary,
runnable Server and hosted Console claims therefore remained
`not_implemented`. The current combined TQ-807/TQ-811 surface is instead an
`implemented_candidate_not_published`: later work adds the daemon, container,
concrete verifier and guarded hosted Console described below.

TQ-802 is now also implemented internally. `@tasq-internal/server` persists
host/workspace routing, principals, issuer/subject bindings, immutable
permission definitions, live grants/delegations/eligibility, idempotency,
decisions and append-only security audit in a separate authority database.
Its router resolves only a host-configured opaque storage binding after an
allow, so a denied foreign-workspace probe invokes no domain-ledger opener.
TQ-626 composes a readable mandate interface over this same authority store.
Issue and revoke atomically create or transition existing permission, grant and
delegation rows; inspection is a checked projection and authorization re-enters
the live TQ-802 evaluator. There is no mandate table. Generic use limits and
budgets fail with typed unsupported results until an enforcing ledger exists,
and remote effect dispatch remains disabled through TQ-906.
TQ-803 wraps that boundary in a Fetch-compatible authenticated read handler.
It publishes RFC 9728 discovery, accepts identity only from a host-supplied
credential verifier, authorizes every request live, supports bounded
commitment reads and payload-free event metadata, and captures one injected
clock snapshot per request. By itself it remains an integration entrypoint;
TQ-807 now supplies the concrete verifier and listener composition.

TQ-804 adds a public state-free operation catalog and host-integrated guarded
mutation handler. Every mutation requires caller-scoped durable idempotency,
one registered action and one injected request timestamp. The authority store
holds a `BEGIN IMMEDIATE` writer gate through the host's domain commit, so a
concurrent revocation cannot cross an admitted mutation. The separate
databases are honestly serialized rather than described as cross-database
ACID; a lost boundary returns typed unknown outcome and exact-retry recovery.
TQ-807 now supplies the bundled Core operation adapter, receipt store and
listener without changing this separate-database recovery boundary. TQ-811
adds bounded same-origin browser forms for create, claim, block, evidence,
explicit unverified evidence-trust attribution, completion proposal and
independent approval. Each form re-enters this exact operation catalog and
guard; the Console contains no direct Core mutation path.

TQ-805 adds a stateless MCP Streamable HTTP adapter inside the same private
Server package. It authenticates each exact MCP request, discards the raw
credential before tool dispatch and projects bounded reads plus dynamically
registered mutation tools through the existing TQ-803/TQ-804 Fetch handler.
Consequently REST and MCP share subject binding, live grants, isolated routing,
decision audit, idempotency and revocation serialization. Official-client
tests and a clean-room eval prove reads, exact replay, conflicting-key denial,
immediate revocation and no foreign-workspace opener. The adapter remains
stateless; TQ-807 exposes it through the candidate daemon without adding a
stateful MCP session.

TQ-809 adds the Fetch-only `@tasq-run/client` source candidate and `tasq
remote` CLI workflow. Endpoint, workspace and credential profile are explicit;
actor text never authenticates. The authority control plane now supports
expiring one-use human-device/workload enrollment, atomically consumed into a
revocable opaque credential while storing only host-peppered digests. The
client exposes bounded reads, registered idempotent mutations, exclusive
event resume and typed cursor-retention recovery. Two-client claim/resource
contention, lost-response replay, next-request revocation, private CLI
credential modes and REST/official-MCP record/cursor parity pass. This closes
the host-integrated TQ-809 slice; `@tasq-run/client` remains absent from
published `v0.3.0`.

TQ-807 now composes those layers into a runnable Bun daemon and reference
Docker/Compose deployment. Strict versioned config binds a canonical HTTPS
origin, static RS256 public JWKs, JWT scope upper bounds and opaque workspace
storage slots. A single Server-owned Core adapter implements registered
commitment, claim, attempt, evidence and resource operations; a separate
immutable receipt store preserves exact remote replay. The same-origin hosted
Console exchanges a checked bearer credential for a Secure HttpOnly cookie
and re-enters guarded REST for every read. Deterministic bootstrap, health,
readiness, bounded metrics, online checksummed backup and create-only restore
pass daemon, restart and real container tests. TQ-807 is
`candidate_done_external_gate`: protected multi-architecture image
publication, SBOM, checksums and provenance remain.

This is the public canonical source repository. `main` requires pull requests,
green macOS and Linux verification, conversation resolution and linear history;
deletion and non-fast-forward updates are blocked. `v*` tags are immutable,
the `release` environment accepts only `v*`, secret scanning and push protection
are enabled, and private vulnerability reporting is active. The repository
contains the seven published package sources plus one ADR-010 remote-client
package candidate and private compatibility, example and eval workspaces.
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
store format 26, and the release policy's `compatibility` block is explicitly
scoped to that published release. Repository source uses candidate format 32
for signed statements, replica-principal binding, portable trusted-binder
descriptors, provider-neutral attestations, exact agreement history, and
settlement/recourse decisions; the separate
`sourceCandidateCompatibility` block records it without granting a shipped
support claim. Each executable reports its exact read/write/direct-migration
ranges. Existing-store upgrades are serialized, snapshot-verified,
receipt-backed and post-checked; newer or ambiguous histories fail before
mutation. Real process-kill recovery and portable create-only workspace
round-trip pass on filesystem databases, and a real file-size quota fails
before schema mutation while retaining only a private diagnostic partial.
Exact `v0.3.0` published bytes now migrate the populated format-5 fixture and
pass post-migration doctor on both targets. The `v0.4.0` pre-release harness
must now replay exact public `v0.2.0` and `v0.3.0` ledgers into candidate format
32. The prior format-28 run passed on Darwin arm64 and Linux x64 GNU but was
superseded by migrations 29 through 32,
including matching-binary restore. Protected run
[30625856802](https://github.com/gwendall/tasq/actions/runs/30625856802) is bound
to source commit `71f7f8c3f70f712ff06d51bec0f30b82cbe372b5`; it is historical evidence, not
the current release gate.
Published `v0.3.0` can touch SQLite WAL/SHM sidecars during its typed refusal
but does not change canonical ledger or recovery state. The exact published
`v0.4.0` replay remains `not_run`; no `v0.4.0` support claim follows from the
protected source-candidate pass. See
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

ADR-009 and TQ-613 freeze the next trust layer: purpose-bound signed
statements, public signing-credential lifecycle and explicit verification
records. TQ-614 implements authority-owned Ed25519 credential enrollment and
lifecycle. TQ-615 persists append-only statements, verification proofs, nonce
use and exact bindings to artifacts, completion resolution, effect approvals,
replication operations and checkpoints. Cross-language canonical vectors,
purpose/routing isolation, untrusted-root rejection, lifecycle failures,
revocation races, transaction composition and portable pruning pass. A valid
signature authenticates bytes and principal only; it never establishes truth,
completion or effect authority. TQ-616 remains
`candidate_done_external_gate` until exact protected downloaded artifacts,
supported-platform replay and an unbriefed-agent trial pass.

TQ-806 binds every replica generation to one authenticated principal. Server
push requires exactly one accepted purpose-bound signed origin per operation
and persists each operation plus proof in the same domain transaction.
Pull also requires the owning principal. Claims, leases, approvals and effects
remain online-only. Existing reorder, duplicate, conflict, cursor-expiry,
process-kill and old-backup chaos evidence still passes; published Server and
client artifacts plus a clean-room multi-machine trial remain external.

TQ-810 adds a checked-in OpenAPI 3.1 remote contract and dependency-free
Python 3.11+ client for reads, event cursors, operation discovery, idempotent
mutation and enrollment. It is deliberately transport-only and contains no
Core, SQLite or migration logic. PyPI publication, provenance and exact
downloaded-wheel replay against the published Server digest remain open.

Protected Server GHCR and Python PyPI publish/certify workflows are prepared
with exact version/source/confirmation inputs, least-privilege jobs and
candidate-specific policy authorization. The maintainer has authorized the
exact `v0.4.0` public-alpha release, its Server image, Python wheel,
`@tasq-run/client` package and TQ-616 downloaded-byte replay. The protected
workflows have not run, so authorization changes no shipped surface and
published `v0.3.0` remains seven packages.

The 2026-07-31 release handoff is an external-activation checkpoint. Main CI
[30625842313](https://github.com/gwendall/tasq/actions/runs/30625842313) and the
two-target protected migration run above are green. No `v0.4.0` tag exists.
The next irreversible step is deliberately the one-shot
`@tasq-run/client@0.1.0-alpha.0` npm bootstrap from protected `main`, because a
new npm identity must exist before its `release.yml` trusted publisher can be
configured. PyPI still needs the `tasq-remote` pending publisher. The
experimental GCP profile is fixed to `europe-west9-a` and
`experimental.tasq.run`, but needs a dedicated billed project, active identity,
DNS control and exact published image digests. Dogfood and blind-human adoption
continue after the alpha; remote effects stay disabled.

TQ-901–TQ-905 add a private managed-Cloud source candidate. Two-tenant hostile
tests pass colliding names, isolated storage bindings, concurrent quota,
cross-tenant denial, BFF CSRF/origin rules, revocation epochs, provider
reconciliation, rotation, backup/restore, retention, support and deletion
recovery. Raw identity subjects, session tokens and Server bearer credentials
are not stored. Real provider, secret-manager, multi-region, operations and
independent security evidence remain external, so Tasq Cloud is not available.
TQ-906 remains pending independent review; Server and Cloud both keep remote
effects disabled.

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
