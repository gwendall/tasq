# Tasq backlog

This is the canonical ordered execution backlog for Tasq. The machine-readable
form is [`BACKLOG.json`](BACKLOG.json). Product claims remain authoritative in
[`../concepts/PRODUCT_SURFACE_MATRIX.json`](../concepts/PRODUCT_SURFACE_MATRIX.json); a backlog item
never turns planned work into shipped behavior.

**Updated:** 2026-08-11

**Current product:** Tasq Core + Tasq Local  
**Current priority:** make the eighth npm identity safe for default installs,
verify its trusted publisher, then publish the maintainer-authorized `v0.4.0`
public alpha: all eight packages and both native artifacts, the
multi-architecture Server image and Python wheel, followed by exact
downloaded-byte certifications. Continue the independent
blind-human session and retained-data dogfood after publication; they gate
human usability and stable graduation, not alpha delivery. Remote effects
remain disabled.

The detailed task inventory, acceptance criteria and verification routes for
public adoption through Server and Cloud are in
[`PUBLIC_ADOPTION_TO_CLOUD_EXECUTION_PLAN.md`](PUBLIC_ADOPTION_TO_CLOUD_EXECUTION_PLAN.md).

### 2026-08-11 external-activation handoff

The complete `v0.4.0` public-alpha source candidate is merged on `main`. The
latest behavior-changing merge, TQ-633 at
`bbf9bde9a23764feb2e3c81aac039fe566e2f5dc`, passes protected CI run
[31455469251](https://github.com/gwendall/tasq/actions/runs/31455469251): the
full Linux/macOS, browser and secret-scan matrix. Protected migration run
[31447846496](https://github.com/gwendall/tasq/actions/runs/31447846496) binds
commit `e27451d3510c71a9f875a48991eb2fd80496bfdb` and passes the exact
`v0.2.0`/`v0.3.0` to candidate-format-32 replay on both supported targets.

The eighth identity now exists as unsupported
`@tasq-run/client@0.1.0-alpha.0`. A public read at 2026-08-11T02:57:46Z found
both `alpha-bootstrap` and `latest` pointing at it, so a default install is not
safe. No `v0.4.0` tag, GHCR image, PyPI wheel or hosted Cloud deployment exists
yet. Resume in this order:

1. verify `@tasq-run/client` trusts `gwendall/tasq:release.yml:release`, the
   GitHub bootstrap secret is absent and its granular token is revoked;
2. configure the `tasq-remote` PyPI pending trusted publisher for
   `gwendall/tasq`, `publish-python.yml`, environment `release`;
3. either remove `latest` from the unsupported bootstrap immediately, or
   create immutable tag `v0.4.0` and let `release.yml` replace it with all eight
   exact npm packages and native assets; verify the public dist-tags, then run
   the protected Server, Python and downloaded-byte certification workflows;
4. deploy the provisioned Fly private-beta profile from the exact protected
   Server digest. The Fly app, Paris volume, CI environment and
   `api.tasq.run`/`cloud.tasq.run` DNS now exist; no Machine is started until
   the digest-bound workflow can verify and deploy the published image.

Independent blind-human adoption and retained dogfood continue after the alpha
and block only human-usability closure and stable graduation. Remote effects
remain disabled.

The latest behavior-changing protected CI run above passed documentation and
generated-truth checks, all typechecks, every functional suite, public-package
reproducibility, Linux/macOS verification, browser suites and the secret scan.
That protected result supersedes the earlier local timeout as the handoff
closure verdict; the registry and deployment gates below remain external.

## What is already proven

The universal kernel, local CLI, local stdio MCP, extension and connector
boundaries, protocol adapters, transactional delivery, explicit replication,
autonomous onboarding, bounded context, external context links and current
read-only loopback Console are implemented and covered by the repository's
tests and evals. TQ-601 froze the product shapes; TQ-602 froze the public legal,
package and governance boundary.

The repository also contains the TQ-605 static public product/docs app. Its
rendered support states and `/product-truth.json` are generated from canonical
machine contracts. It is repository-certified and deployed from public `main`
at <https://tasq.run>. This URL is not a package-release claim.

The dedicated canonical repository is public and Linux/macOS CI is live.
Pull requests, both verification checks, linear history, immutable `v*` tags,
secret scanning, push protection and private vulnerability reporting are
platform-enforced. Repository visibility is still not release evidence.
Release archives and seven `@tasq-run/*` package candidates are deterministic and
clean-room tested. PR [#5](https://github.com/gwendall/tasq/pull/5) added and
certified the candidate install/upgrade/restore/uninstall lifecycle on both
native targets.

The repository follows open-source engineering discipline as a public alpha:
standalone source authority, public/private package boundaries, DCO,
reproducible setup, Linux/macOS CI, complete onboarding and versioned machine
truth. TQ-607 separates alpha distribution from stable product readiness. The
next proofs are the exact protected `v0.4.0` bytes and repeated useful
operation through real adopters, not more repository-only architecture.

## Current gates

- **Fly private beta — substrate provisioned, runtime image pending.** ADR-018
  replaces GKE as the first hosted-beta step. Fly app `tasq-api`, one encrypted
  `cdg` volume with 30-day snapshots, ingress, certificate request, registrar
  DNS and GitHub environment `beta` exist. `api.tasq.run` is the sole future
  Server origin; `cloud.tasq.run` is the human redirect. The protected workflow
  accepts only the attested GHCR digest and enforces one writer. No public
  endpoint or Managed Cloud claim exists until v0.4.0 Server publication,
  bootstrap and the live HTTP proof pass. See
  [`ADR-018`](../decisions/ADR-018_FLY_PRIVATE_BETA.md) and the
  [runbook](../../deploy/fly-private-beta/README.md).

- **Public Local alpha — live.** Anonymous users can clone `main`, install all
  seven `@tasq-run/*@0.3.0` packages from npm, or download the attested
  macOS-arm64/Linux-x64 assets from the immutable
  [`v0.3.0`](https://github.com/gwendall/tasq/releases/tag/v0.3.0) release.
  The historical `alpha-bootstrap` tag is not a supported channel. The separate
  `@tasq-run/client` bootstrap currently also occupies `latest`; do not use its
  default install until TQ-633's external registry gate is cleared.
- **TQ-633 — source controls complete; npm cleanup required.** The one-shot
  client workflow serializes with protected releases, preserves
  `alpha-bootstrap`, removes a bootstrap-only `latest`, and verifies the result.
  Every protected release verifies each public package's `latest` against the
  exact release version. The current public registry still needs an npm
  package-owner mutation, so the ticket is not marked done.
- **TQ-321 — done, zero-context agent integration.** Native Codex and Claude
  Code marketplace paths pass real isolated install, two-process behavioral and
  uninstall trials. Both hosts read before mutation, resume the same attempt
  from an exclusive cursor, reject stale resource authority, complete with
  evidence and preserve the ledger byte-for-byte through uninstall. See
  `../contracts/TQ-321_AGENT_PLUGIN_CERTIFICATION.json` and
  `../../evidence/tq-321/latest.json`.
- **TQ-608 — source candidate complete; published-v0.4 replay open.** The
  executable and release manifests declare store compatibility; existing-store
  upgrades create verified private snapshots and durable receipts, fail closed
  on ambiguous/newer history, reconcile real process kills, run post-checks and
  support bounded create-only portable import. A real file-size quota proves
  snapshot failure before schema mutation. Exact `v0.3.0` bytes migrate the
  populated format-5 fixture on both targets. The exact `v0.2.0`/`v0.3.0` to
  candidate-format-28 N-2 harness was superseded by migrations 29 through 32.
  The format-32 harness passed against source commit
  `e27451d3510c71a9f875a48991eb2fd80496bfdb` in protected Linux and macOS run
  [31447846496](https://github.com/gwendall/tasq/actions/runs/31447846496).
  Only candidate artifact attestations and the exact published `v0.4.0` replay
  remain open. No source-candidate pass grants a public support claim.

- **TQ-607 — in progress, private multi-application dogfood.** The program must
  span at least 30 calendar days, including at least 20 active personal-use
  days, real Kami resource contention/fence/reclaim, and a Denshin-shaped or
  equivalent interactive-runtime lifecycle. It also requires two retained-data
  upgrades, backup/restore, replacement-agent recovery, cold onboarding and an
  explicit `go`, `extend` or `no_go` decision. See
  `../contracts/TQ-607_PRIVATE_DOGFOOD_GATE.md` and `../contracts/TQ-607_DOGFOOD_STATUS.json`. The
  baseline, Kami and interactive-runtime journeys, backup/restore,
  replacement-agent recovery, cold onboarding, support review and first
  forward upgrade are retained. The personal track is at 1/20 active days and
  1/3 required journeys; run `pnpm --silent dogfood status --json` for the
  authoritative live counters and next action.
- **TQ-603 — done, first protected release published.** The maintainer
  authorized `v0.1.0` as an explicitly labeled public alpha on 2026-07-23.
  The authenticated `gwendall` operator controls the `tasq-run` npm
  organization; `npm team ls tasq-run` returned its developers team on
  2026-07-23. Protected bootstrap run
  [30005833862](https://github.com/gwendall/tasq/actions/runs/30005833862)
  published and byte-verified all seven `0.1.0-alpha.0` identities under the
  non-default `alpha-bootstrap` tag. Every package now trusts
  `gwendall/tasq:.github/workflows/release.yml:release`; the bootstrap secret
  is deleted and its granular token revoked. Protected run
  [30011315256](https://github.com/gwendall/tasq/actions/runs/30011315256)
  then published all seven `0.1.0` packages through OIDC and built both native
  targets from commit `0f5357ea10e0eb9f86f143a4fc38030624238bd2`.
  The exact attested artifacts are attached to immutable tag `v0.1.0`; the
  current release certificate now tracks `v0.3.0`. The tag workflow
  fails before building unless the exact version, repository, package boundary,
  maintainer decision and channel-specific gates match. Unreviewed workstation
  builds, implicit visibility changes and long-lived automation tokens remain
  forbidden.
- **TQ-604 — done.** Protected run
  [30015923266](https://github.com/gwendall/tasq/actions/runs/30015923266)
  downloaded the exact `v0.1.0` release, verified every GitHub attestation and
  passed install, onboarding, contention, Console, backup, upgrade, restore and
  data-preserving uninstall on macOS ARM64 and Linux x64.

During alpha and TQ-607, fixes discovered by real adopters are in scope. New
Server/Cloud breadth remains behind published-byte Local certification.

## Ordered checkpoints

### 1. Harden the public alpha

- **TQ-321 — done:** the full native Codex and Claude Code two-process matrix
  passes from the public marketplace with no repository briefing.
- **TQ-608 — done for current release:** exact published `v0.3.0` replay
  passes; the exact `v0.2.0`/`v0.3.0` N-2 candidate harness passes locally and
  in protected CI on both targets. Only the published-`v0.4.0` replay remains
  `not_run`.

### 2. Finish Local alpha distribution

- **TQ-603 — done:** `v0.1.0`, seven npm packages and both native artifact
  sets are published with immutable coordinates and provenance.
- **TQ-604 — done:** downloaded release, target, source commit and protected
  workflow evidence are recorded in the lifecycle certificate.

### 3. Complete the Local Console

- **TQ-701 — done:** the audited inspector now shares bounded canonical JSON
  read models for active commitments, actors, claims, resources, waits,
  effects, redacted audit and honest operational health. Pages use scoped
  keyset cursors and every read has one injected time snapshot. See
  `../contracts/TQ-701_CONSOLE_READ_MODELS.md`.
- **TQ-702 — done:** cursor-driven loopback SSE and bounded polling now share a
  redacted event-batch contract with exclusive reconnect, typed gap/ahead
  recovery, one-frame backpressure and exact overflow continuation. It creates
  no second truth and injects both authority time and transport scheduling. See
  `../contracts/TQ-702_CONSOLE_LIVE_TRANSPORT.md`.
- **TQ-703 — done:** the server-rendered operator Console now provides
  accessible responsive navigation, bounded page filters, an audit timeline,
  explicit live/stale states and a preview-before-download redacted support
  bundle. It stays read-only and unauthenticated only because it stays on
  loopback. See `../contracts/TQ-703_OPERATOR_CONSOLE.md`.
- **TQ-704 — done:** installed Tasq Local
  now starts one explicit foreground Console, emits a versioned machine
  announcement, proves live discovery with `web status`, cleans crash-safe
  private registration, and preserves same-ledger Console behavior through
  upgrade and uninstall. Standalone and npm candidates load the full UI without
  checkout-relative assets or hidden listeners. See
  `../contracts/TQ-704_INSTALLED_CONSOLE_LIFECYCLE.md`; exact downloaded-byte
  confirmation passes on both supported targets.

### 4. Explain and validate the public product

- **TQ-605 — done:** the distinct static Next.js + TypeScript + Tailwind +
  shadcn/ui product/docs app covers every current consumer journey, renders
  support and release gates from versioned repository truth, exports the same
  machine JSON and uses only synthetic illustrations. It is deployed from
  public `main` at <https://tasq.run>. See
  `../contracts/TQ-605_PUBLIC_SITE.md`.
- **TQ-609 — done:** every public command, example, product promise and Local
  limitation is now exact and executable. The prefix-install/PATH mismatch,
  rendered `+` markers, illustrative onboarding JSON, nonexistent SDK API,
  stale pre-publication prose and overly architectural first explanation are
  removed. Site tests execute the displayed install, onboarding, MCP, Console,
  operations and Core examples against the published release; browser
  acceptance verifies the real Local Console evidence and Local-only boundary.
- **TQ-610 — done:**
  verified `bunx`/`npm exec` try paths, the versioned checksum-authenticating
  persistent installer, stable `/SKILL.md`, `/agents`, `/llms.txt` and
  `/integration.json` entrypoints, explicit Codex/Claude/generic MCP recipes,
  an isolated demo, the non-secret project rendezvous schema and the one-command
  human setup are published in `v0.1.1`. Integration `0.1.2` passes the
  public-main native Codex and Claude matrix with zero interventions. The
  protected npm/native release and downloaded-byte recertification pass on
  macOS ARM64 and Linux x64 GNU. See
  `../contracts/TQ-610_ACQUISITION_AND_AGENT_ENTRYPOINT.md`.
- **TQ-611 — done:**
  `createLocalTasq` now binds an explicit store, workspace, actor and clock
  behind one deep `@tasq-run/core` interface. Generated candidates contain
  compiled ESM and declarations; fresh Node 22 and Bun consumers both pass the
  same-ledger restart journey, and the npm README is generated from the
  executable example. Protected `v0.3.0` packages and native assets are
  published; exact registry tarballs pass the same Node/Bun restart journey
  and both native targets pass the full post-release replay. See
  `../contracts/TQ-611_EMBEDDED_TYPESCRIPT_CLIENT.md`.
- **TQ-612 — done:** ADR-005 is accepted.
  Core, embedded client, CLI, capability-scoped local MCP, canonical
  inspection and Local Console now separate evidence trust, completion
  proposals, challenges, versioned decisions and final completion.
  Deterministic, independent-attestation, optimistic-challenge and adjudicated
  policies expose `too_early`, `indeterminate` and `challenged` without
  importing economic bonds. Adversarial and portable-data tests pass. Protected
  `v0.3.0`, all seven registry tarballs and both native targets pass the exact
  downloaded-byte certification; see
  `../contracts/TQ-612_INDEPENDENT_COMPLETION_RESOLUTION.md`.
- **TQ-606 — published-byte automation complete, human gate:** `/adopt.json` now closes the
  machine path before the executable. Package-independent Python/Node consumers
  install candidate bytes outside the checkout, onboard two actors, recover
  typed contention with a higher fence, complete with evidence and inspect the
  same ledger through installed Console. The first published-byte replay passes
  on both targets. Final closure requires one independent unbriefed human
  session. The observer protocol, redacted evidence template and fail-closed
  validator are ready; run
  `pnpm --silent adoption:validate -- --evidence <record.json>` after the real
  session. See `../contracts/TQ-606_PUBLIC_ADOPTION.md`.
- **TQ-705 — done:** fixed-clock, process-isolated empty, mature, hostile,
  corrupt and 2,501-commitment fixtures now run through the production Console
  in real Chromium on Linux and macOS. The gate proves safe corruption failure,
  escaping/redaction, bounded keyset pages, responsive operation and HTTP
  read-only behavior; see `../contracts/TQ-705_CONSOLE_BROWSER_CERTIFICATION.md`.

### 5. Certify external interactive runtimes

- **TQ-320 — done:** a clean-room runtime
  now installs generated `@tasq-run/*` tarballs and proves explicit assignment,
  lost-response retry, claim expiry and higher-fence reclaim,
  `input_required` resume on the same attempt, two runs in one conversation,
  immutable terminal state, distinct artifacts/evidence, cursor recovery and
  explicit completion. The autonomous CLI guide also exposes additive
  retry-safe attempt recipes; no Machine, terminal, conversation or provider
  ontology entered Core. The same fixture passes from exact protected
  `@tasq-run/*@0.3.0` packages on both supported targets. See
  `../contracts/TQ-320_INTERACTIVE_RUNTIME_CONSUMER.md` and
  `../contracts/TQ-320_INTERACTIVE_RUNTIME_CERTIFICATION.json`.

  TQ-607's Denshin journey remains private product-learning evidence.

### 6. Prove retained product value for stable graduation

- **TQ-607:** continue the three-consumer dogfood program on retained ledgers,
  classify every material workaround, complete the cross-cutting recovery
  drills and record the stable-graduation decision. The remaining execution is
  repeated personal use, the open/blocked/resumed/evidence path, the
  no-direct-store-repair proof, one more forward upgrade and the minimum
  calendar duration. Passing repository tests or publishing alpha bytes cannot
  manufacture this evidence.

### 7. Build self-hosted Tasq Server

- **TQ-801 — done:** strict verified-identity/binding/grant/decision contracts,
  16 digest-bound actions and one pure injected-clock evaluator implement the
  inner ADR-004 guard without claiming a remote surface. See
  `../contracts/TQ-801_HOSTED_AUTHORITY_FOUNDATION.md`.
- **TQ-802 — done:** a checksum-migrated authority control plane now owns
  revisioned/idempotent bindings, grants, delegation, eligibility, decisions
  and append-only audit. The host-configured opaque router opens no workspace
  ledger before an allow; see `../contracts/TQ-802_AUTHORITY_STORE_ROUTER.md`.
- **TQ-803 — done:** host-integrated Fetch REST handler with RFC 9728
  discovery, strict verifier boundary, live authorization, bounded commitment
  reads and payload-free event metadata. It has no listener or concrete
  credential adapter; see `../contracts/TQ-803_HOSTED_READ_REST.md`.
- **TQ-804 — done:** registered mutation REST now requires caller-scoped
  idempotency and holds the live authority writer gate through the host's
  durable domain commit. Cross-database loss becomes typed exact recovery, not
  fake ACID; see `../contracts/TQ-804_GUARDED_MUTATION_REST.md`.
- **TQ-805 — done:** stateless Streamable HTTP remote MCP authenticates each
  exact request, discards raw credentials and projects registered read and
  mutation tools through the same TQ-803/TQ-804 handlers and live ADR-004
  guard. It adds no listener, concrete verifier or deployable Server; see
  `../contracts/TQ-805_REMOTE_MCP.md`.
- **TQ-809 — done:** the Fetch-only `@tasq-run/client` source candidate,
  `tasq remote` CLI profiles and one-use human/workload enrollment now use an
  explicit endpoint/workspace, private local credential storage, exact
  idempotent replay, live revocation and cursor-expiry recovery. Two-client
  claim/resource contention and REST/MCP parity pass. The package is not in
  published `v0.3.0`, and no deployable endpoint ships; see
  `../contracts/TQ-809_REMOTE_CLIENT_AND_ENROLLMENT.md`.
- **TQ-807 — candidate complete, authorized publication in progress:** the Bun daemon and local
  Linux container now include strict config/bootstrap, concrete RS256 and
  opaque verification, real Core operations, immutable mutation receipts,
  the same-origin authenticated Console BFF base, health/metrics and checksummed
  backup/restore. Its original read-only slice is historical; TQ-811 owns the
  current bounded guarded actions. `v0.4.0` publication is authorized; the
  remaining gate is the protected multi-architecture image with immutable
  registry digest, SBOM, checksums and provenance; see
  `../contracts/TQ-807_DEPLOYABLE_SERVER.md`.
- **TQ-808 — candidate complete, external gate:** the production daemon passes
  two independent issuers/workspaces, hostile credentials, REST/MCP/CLI
  parity, live revocation race, `SIGKILL` restart, older-backup recovery and
  support-bundle redaction. Exact published multi-arch client replay and one
  unbriefed operator deployment remain; see
  `../contracts/TQ-808_SELF_HOSTED_HOSTILE_CERTIFICATION.md`.

### 7A. Close the first shared-work product loops

These are consumer adapters over the certified Server. They do not add task
state, provider schemas or notification policy to Core.

- **TQ-811 — candidate complete, Server publication gate:** the authenticated
  Console now supports create, claim, block, evidence, explicit unverified
  evidence-trust attribution, completion proposal and independent approval.
  Every action is a bounded same-origin form translated into the same
  registered Server operation, live ADR-004 authorization and Core service
  used by REST and MCP. Console owns no mutation semantics. Exact
  published-image browser certification remains coupled to TQ-807/TQ-808; see
  `../contracts/TQ-811_HOSTED_HUMAN_ACTIONS.md`.
- **TQ-812 — done:** `@tasq-internal/github-bridge` freezes one owner per issue
  field, produces Core-compatible immutable `external_ref` inputs and verifies
  exact GitHub webhook bytes before emitting typed issue, pull-request, check
  and deployment observations. Foreign URLs, signature tampering and
  unsupported events fail closed. GitHub discussion stays in GitHub and every
  observation carries `completionMapping: none`; see
  `../contracts/TQ-812_GITHUB_BRIDGE.md`.
- **TQ-813 — done:** `@tasq-internal/webhook-notifier` turns assignment,
  blocking, authority expiry, recovery, validation and challenge attention
  into a bounded neutral envelope with stable delivery identity, HMAC
  signature and exact receiver acknowledgement. It is a handler for the
  existing transactional outbox: explicit 429/503 responses retry the same
  identity, transport or acknowledgement uncertainty stays indeterminate, and
  redirects fail closed. Email, Slack and other providers remain downstream
  adapters; see `../contracts/TQ-813_ATTENTION_WEBHOOK.md`.

The first managed alpha may operate one dedicated certified Server deployment
per user or team. A shared multi-tenant control plane, billing and broad
support claims remain TQ-901–TQ-905.

### 7B. Add portable signed statements

- **ADR-009 — accepted:** use a purpose-bound signed statement over canonical
  bytes, not a generic signed document. Private keys remain host-owned;
  signature verification, principal binding, live authorization, semantic
  validation and witnessed presence remain separate.
- **TQ-613 — done:** strict portable payload/envelope/credential/verification
  schemas, DSSE PAE, baseline Ed25519 signing and verification, nonce
  consumption and TypeScript/Python/OpenSSL vectors pass.
- **TQ-614 — done:** the separate Server authority database now owns
  proof-of-possession enrollment, explicit isolation classes, immutable public
  material, rotation/recovery links and CAS-gated
  suspension/resumption/revocation/compromise/retirement with append-only
  credential events. The Extension SDK signer is purpose-scoped and has no
  arbitrary-byte signing entrypoint; see
  `../contracts/TQ-614_SIGNING_CREDENTIAL_AUTHORITY.md`.
- **TQ-615 — done in source:** migration 27 persists exact statements,
  verification records, immutable public credential snapshots, nonces,
  checkpoints and six typed bindings. Current store format 32 additionally
  binds replica generations to principals, freezes trusted binder descriptors
  and stores provider-neutral attestations, exact agreement history, and
  settlement/recourse decisions. Core, embedded client, guarded
  Server, CLI, MCP, Console, doctor and portable-data projections pass; the
  unsigned journey is unchanged. See
  `../contracts/TQ-615_SIGNED_STATEMENT_INTEGRATION.md`.
- **TQ-616 — candidate done; external gate remains:** the critical machine
  threat matrix, Python cross-language vector, nonce/identity replay,
  revocation race, process-loss migration and restore tests pass. Public
  support still requires the protected exact downloaded-byte, supported
  platform and unbriefed-agent certification. See
  `../contracts/TQ-616_SIGNED_STATEMENT_CERTIFICATION.md`.

The accepted contract is
[`TQ-613_SIGNED_STATEMENT_ARCHITECTURE.md`](../contracts/TQ-613_SIGNED_STATEMENT_ARCHITECTURE.md);
the machine gate is
[`SIGNED_STATEMENT_ACCEPTANCE.json`](../contracts/SIGNED_STATEMENT_ACCEPTANCE.json).
This work does not interrupt TQ-607 retained-data dogfood. Signed statements
are implemented in the source candidate but remain an unpublished support
claim until TQ-616's external gate is attached to exact release bytes.

- **TQ-806 — candidate done; external gate remains:** guarded Server
  enrollment/push/pull now bind each replica generation to one principal and
  require one atomically persisted signed-origin proof per pushed operation.
  Existing chaos, cursor, conflict and old-backup recovery pass; claims,
  leases, approvals and effects remain online-only. See
  `../contracts/TQ-806_AUTHENTICATED_OFFLINE_REPLICATION.md`.
- **TQ-810 — candidate done; external gate remains:** the checked-in OpenAPI
  contract and dependency-free Python 3.11+ client cover reads, event cursors,
  operation discovery, idempotent mutation and enrollment without embedding
  Core or migrations. PyPI publication, provenance and downloaded-wheel
  replay remain. See `../contracts/TQ-810_REMOTE_SDKS.md`.

Server is not the Local loopback inspector exposed on a public interface. It
must implement the complete ADR-004 trust chain first.

### 7C. Guard the intake the way completion is guarded

Tasq guards how work leaves the queue: completion needs evidence, and validated
tasks need an independent decision. Nothing yet guards how work enters it, or
what it may cost while claimed. That asymmetry is tenable while humans feed the
queue and breaks in the autonomous regime, where agents feed it. Two public
results frame the risk: duplicated work is the top measured rejection cause for
agent-generated pull requests (23% of 562 hand-coded rejections,
<https://arxiv.org/html/2601.15195>), and mutual exclusion alone does not
prevent it - locks plus shared state do
(<https://arxiv.org/html/2606.19616v1>). Public postmortems of uncapped agents
reaching $4,200 and $47,000 motivate the cost bound.

- **TQ-617 — source candidate complete; v0.4 publication gate remains:**
  `discovered_from` is a first-class relation plus
  a zero-cost capture command: an agent that finds work mid-task files it as a
  linked task without releasing its claim or widening its diff, and the CLI
  prints the ready capture command at the moment of a refusal or error.
  Capture stays local and explicit by default.
- **TQ-618 — candidate done, publication gate:** provider-neutral observed cost
  is attributed per attempt through explicit immutable meter receipts and
  aggregated per task. A typed hard bound can refuse lease renewal without
  instrumenting agent reasoning; strict mode also refuses an unmetered active
  attempt. This source candidate adds no migration and makes no billing-truth
  claim. It becomes supported only when the exact implementation ships in the
  authorized `v0.4.0` artifacts.
- **TQ-619 — candidate done, publication gate:** a task can atomically record
  the exact observation and proposition that motivate it. That premise is
  refutable through proposal, challenge and independent decision mechanics;
  accepted refutation invalidates actionability, releases active authority and
  preserves the commitment plus its full history. The Local/Core source is
  complete and becomes supported only in the exact authorized `v0.4.0`
  artifacts.
- **TQ-620 — done:** human attention is a bounded resource. Digest-bound
  `input_required` requests batch through the existing durable outbox; absolute
  do-not-disturb intervals suppress transport, and cohort metrics compare
  solicitations only with full delivery coverage and externally assessed
  decision quality.
- **TQ-621 — done:** a sourced public comparison page answers the one
  question that separates coordination tools - what happens when several
  agents work the same backlog in parallel - with every claim carrying its
  source and no claim exceeding what the shipped product does. The canonical
  matrix freezes the published Tasq Local `v0.3.0` boundary, labels inferences
  and backs the rendered `/compare/` page with executable traceability tests.

### 7D. Coordinate delegated action without verticalizing Core

[`DELEGATED_ACTION.md`](../concepts/DELEGATED_ACTION.md) defines the
first-principles composition for consequential work entrusted to another
human, agent, service or runtime. Physical work is the initial stress test, not
a new task kind. These items do not interrupt the authorized `v0.4.0`
publication sequence and create no current support claim.

- **TQ-622 — done:** ADR-011 compares store-owned, URI-only and structured
  target designs and selects a provider-neutral schema value contract with no
  new Kernel record. One pure Interface derives `external_ref`, authority,
  resource, observation and signed-statement bindings from an exact canonical
  digest; cross-domain drift, privacy and hostile cases are executable tests.
- **TQ-623 — done:** `createLocalTasq` exposes existing assignments, artifacts,
  external references and the complete effect ledger. Reentrant root
  transactions compose atomic `claimAndStart` and `submitOutcome` journeys,
  including child idempotency and post-commit journal delivery. Rollback,
  lost-response restart and exact generated-tarball Node/Bun tests pass while
  the original `add -> list -> done` example remains byte-unchanged.
- **TQ-624 — done:** ADR-012 replaces the closed signed-statement binding list
  with portable versioned descriptors paired only with trusted host code.
  Unknown, stale, conflicting, unpinned and cross-workspace binders fail closed;
  migration 29 preserves the six historical meanings and exact descriptors
  survive portable restore. TypeScript and Python share the canonical vector.
- **TQ-625 — done:** ADR-013 and the embedded Attestations Module freeze
  purpose-scoped assertions, canonical scope, evidence, validity,
  supersession and issuer-only append-only revocation. Explicit-time current
  queries and exact eligibility policies keep claim truth, availability and
  authority separate; a pinned custom binder authenticates the issuer and
  exact bytes without upgrading those assurances. Licence, access, provenance,
  hostile workspace, temporal and portable-restore tests pass.
- **TQ-626 — done:** ADR-014 and the private Server Mandates Module freeze
  issue, inspect, authorize and revoke over a checked projection of existing
  permission, grant and delegation rows. Issue/revoke are one CAS-serialized
  authority mutation; the next request sees revocation. Denials expose only a
  protected target digest. Generic limits and budgets fail typed rather than
  pretending enforcement, effect limits stay in approval policy, and remote
  dispatch remains disabled through TQ-906.
- **TQ-627 — done:** ADR-015 and the embedded Agreements Module freeze
  canonical offers, exact party acceptances, termination, expiry and amendment.
  The final acceptance atomically compiles reciprocal evidence commitments and
  TQ-612 resolution contracts; failure rolls everything back. Accepted
  amendments cancel prior non-terminal obligations without rewriting history.
  Assignment acceptance remains responsibility only and grants neither consent
  nor effect authority.
- **TQ-628 — done:** ADR-016 and the embedded Settlement/Recourse Modules
  snapshot exact agreement, commitment, attempt, validation and prior-effect
  facts. Versioned rules derive full, partial, show-up, cancellation, rework,
  credit or indeterminate entitlements and atomically create new commitments
  plus optional proposed effects. Completion is never rewritten, effect
  authority stays separate, and no escrow or record-role claim is made.
- **TQ-629 — done:** the private reference delegated-action Runner consumes
  durable outbox leases, requires a live claim/fence callback at the connector
  mutation boundary, reconciles persisted executing or indeterminate effects
  by provider lookup, and reuses Core's exactly-once settlement/recourse
  boundary. Its bounded Review Inbox re-reads assignment, agreement, injected
  eligibility, attempt, evidence-resolution, effect, settlement, overdue
  recourse and experimental custody facts without persisted shadow state.
- **TQ-630 — done:** private Evidence Capture and Outcome Bundle Modules freeze
  exact session/byte/source/attempt/target/criterion bindings, verify immutable
  store acknowledgements and atomically append Artifact plus Evidence. Complete
  redaction, original-byte, retention, deletion and omission disclosures travel
  with the manifest. Deterministic bundles embed exact commitment, agreement,
  attempt, evidence, resolution and effect records plus external authority,
  custody and raw-byte references or omissions; signatures authenticate only
  canonical bytes, and live re-read distinguishes stale from missing records.
- **TQ-631 — done:** ADR-017 rejects leases as custody and signed observations
  as successor election, then graduates atomic first-class handoff to a private
  experimental Module. Exact target/condition/evidence binding, offer,
  accept/refuse, one-successor election, incident lineage, retry, expiry and
  create-only portability pass parcel, equipment and cryptographic-control
  scenarios. Kernel/remote admission, physical truth, ownership and effect
  authority remain explicitly unclaimed.
- **TQ-632 — done:** one closed certifier passes physical verification, remote
  hands, software deployment, procurement, custody and compromised-agent
  denial without provider-specific Core changes. Hostile target drift,
  no-access, partial/timeout, revocation, self-review, unsafe redispatch and
  concurrent handoff paths fail closed; restart replay, independent review and
  Core/custody portable imports pass. The private property-exterior Profile is
  published in source as `reference_only`, with no supply, marketplace,
  provider, access, identity, price, physical-truth or remote-effect claim.

### 7E. Keep unsupported bootstrap off default install

- **TQ-633 — candidate done; external registry gate remains:** protected
  bootstrap and release workflows now serialize package publication and prove
  their intended dist-tags. Public observation still shows unsupported
  `@tasq-run/client@0.1.0-alpha.0` as `latest`; only npm package-owner authority
  can remove it or replace it with the exact supported `v0.4.0` publication.

### 7F. Make local multi-space work and feedback self-describing

- **TQ-634 — source candidate complete; v0.4 publication gate remains:**
  `tasq use` privately binds a canonical directory tree to a validated space,
  inherits the closest binding and preserves explicit flag/environment
  precedence without changing the global default or writing repository state.
- **TQ-635 — source candidate complete; v0.4 publication gate remains:**
  `tasq agent instructions` renders static protocol text with only a validated
  space as input. Full digest markers, atomic idempotent writes, hand-edit
  refusal/force and distinct missing/stale/edited CI exits keep one root block
  current. Documentation now consistently distinguishes live ledger ownership,
  versioned backlog scope and product support truth.
- **TQ-636 — source candidate complete; v0.4 publication gate remains:**
  `tasq feedback` fsyncs a bounded private report while offline and records
  only secret-free failed-command shape. Listing, dry-run and explicit
  token-from-environment GitHub batch publication retain local receipts and
  reconcile by report marker; issue activity remains observation-only.

### 8. Build managed Tasq Cloud

- **TQ-901 — candidate done; deployed-service gate remains:** the private,
  provider-neutral control-plane package implements authorized tenant
  lifecycle, isolated workspace bindings, durable provisioning intent,
  reconciliation and concurrent quota admission. A production database,
  provider binding and independent infrastructure review remain.
- **TQ-902 — candidate done; deployed-browser gate remains:** the same-origin
  BFF keeps Server credentials out of browsers, binds sessions to tenant and
  device, requires CSRF plus exact Origin for mutations and strips cookies.
  Real IdP/browser/security-review evidence remains.
- **TQ-903 — candidate done; external identity gate remains:** HMACed identity
  subjects, device-bound sessions, recovery/tenant epochs and revision-checked
  workload revocation are implemented. Real OIDC, secret-manager issuance and
  operator recovery drills remain.
- **TQ-904 — candidate done; operated-provider gate remains:** quotas,
  expiring exports/backups, retention sweep, retryable deletion, restore,
  credential-reference rotation, incidents, restricted support and
  non-authoritative billing are implemented. Provider byte deletion,
  backup/restore, rotation and on-call evidence remain.
- **TQ-905 — candidate done; independent operations gate remains:** the
  two-tenant hostile source matrix passes isolation, quota race, BFF,
  revocation, reconciliation, rotation, backup/restore, retention and
  deletion recovery. Exact deployed artifacts, real provider drills,
  multi-region recovery and independent review remain.
- **TQ-906 — pending independent review:** ADR-005 and TQ-612 are accepted,
  but TQ-616 is not published-artifact certified and the current author cannot
  independently approve their own authority boundary. Server reports effects
  disabled, Cloud denies every `/effects` path and no remote dispatch
  operation is registered. See
  `../contracts/TQ-906_REMOTE_EFFECTS_REVIEW_GATE.md`.

## Definition of done

Every checkpoint must have:

1. a first-principles contract and explicit authority owner;
2. no provider policy, credential or runtime ownership leaking into Core;
3. an injected `Clock` for every authoritative time decision;
4. state-based tests plus adversarial evals for concurrency, trust, persistence
   or onboarding changes;
5. updated human and machine product truth with honest non-claims;
6. a DCO-signed commit, reviewed PR, green Linux/macOS CI evidence and merge;
7. external evidence when the claim concerns a registry, published artifact or
   deployed service.

TQ-607 additionally requires retained real-use evidence: a synthetic eval may
verify a fix but cannot replace the dogfood duration, adopter journeys or
maintainer launch decision.

## Decisions still required

ADR-005 and ADR-009 are accepted. TQ-612 is published and certified;
TQ-613–TQ-615 are implemented in source, while TQ-616 still requires protected
published-artifact and unbriefed-agent evidence. TQ-906 remote effects requires
its own independent authority review and deployment evidence; completion trust
and a valid principal signature do not grant effect authority.

## Explicit non-goals

- no generic editable todo UI that bypasses canonical services;
- no public binding of the unauthenticated Local Console;
- no custom workflow engine, vector memory or provider credential store;
- no actor label treated as authentication or permission;
- no device-clock last-write-wins or hidden wall-clock authority;
- no Server/Cloud claim based only on an ADR, inner kernel or website mockup.
