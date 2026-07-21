# Current state

Tasq currently ships source for two local product shapes:

- **Core:** an embeddable, profile-neutral coordination kernel;
- **Local:** the CLI, local stdio MCP transport and read-only loopback Console.

Server, remote REST/MCP and Cloud are planned, not implemented. Provider
connectors, domain policy and agent runtimes remain outside Core.

TQ-801 implements Server's first internal building block:
`@tasq-internal/authority` owns strict verified-identity, binding, principal,
permission, grant, delegation, eligibility, request and decision contracts;
16 exact action identities; and a pure deny-by-default evaluator. It consumes
one injected clock snapshot and has no transport, credential verification,
persistence, store routing or kernel dependency. Consequently it creates no
new human or agent entrypoint and does not change the `not_implemented` Server,
REST, remote MCP or hosted Console support claims. TQ-802 is the next
executable checkpoint.

This is the canonical public source repository. `main` requires pull requests
and green Linux/macOS CI; release tags are immutable and the `release`
environment accepts only `v*` tags. The repository contains seven public
package sources and private compatibility, example and eval workspaces. A
package is not available merely because its source exists here; npm
availability starts only after a protected attested release.

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

TQ-705 certifies the Local Console in real Chromium on both Linux and macOS.
Five fixed-clock, process-isolated ledgers cover empty, mature, hostile,
corrupt and 2,501-commitment states. Pagination stays bounded, hostile content
stays inert, support metadata stays redacted and corrupt canonical state fails
with a generic operator-safe error. This is a Local browser gate, not a hosted
Console or broad browser-engine claim.

The shortest verified loop is:

```text
commitment → claim → attempt → evidence → explicit completion
```

Typed waits, observations, reconciliation, resource leases, effects,
replication, bounded context and audit history extend that loop without making
runtime success equivalent to commitment completion.

Authority time is injectable throughout the kernel. Raw device time is allowed
only in the explicit `systemClock` composition adapter.

For orientation, read `README.md`, `PRODUCT_CONSUMPTION_SPEC.md`,
`UNIVERSAL_KERNEL_SPEC.md`, `BACKLOG.md`, `ARCHITECTURE.md`, and `SECURITY.md`,
then run `pnpm typecheck` and `pnpm test`.
