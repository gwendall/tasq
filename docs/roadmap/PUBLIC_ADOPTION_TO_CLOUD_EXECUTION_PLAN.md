# Public adoption to Server and Cloud execution plan

**Status:** active execution specification

**Updated:** 2026-07-31

**Machine authority:** [`BACKLOG.json`](BACKLOG.json)

**Support truth:** [`../concepts/PRODUCT_SURFACE_MATRIX.json`](../concepts/PRODUCT_SURFACE_MATRIX.json)

This document turns the public-adoption audit into an ordered implementation
plan. It is deliberately more detailed than `BACKLOG.md`: a new human or coding
agent should be able to select the next item, find its owning files, understand
what must remain false, and know which proof closes the work.

Nothing in this plan changes a support claim by itself. A surface remains at
its current state in `PRODUCT_SURFACE_MATRIX.json` until implementation,
documentation and the stated evidence gate all pass.

## 0. Current execution checkpoint

The repository implementation phase is complete for the maintainer-authorized
`v0.4.0` public alpha. The full source candidate is merged on `main`; CI run
[30625842313](https://github.com/gwendall/tasq/actions/runs/30625842313) and
protected N-2 migration run
[30625856802](https://github.com/gwendall/tasq/actions/runs/30625856802) pass.
The latter is bound to commit
`71f7f8c3f70f712ff06d51bec0f30b82cbe372b5` and covers Darwin arm64 plus
Linux x64 GNU.

The active queue is external activation, not more repository implementation:

```text
npm client bootstrap -> npm OIDC binding -> PyPI pending publisher
-> immutable v0.4.0 tag -> npm/native/GHCR/PyPI publication
-> exact downloaded-byte certifications -> experimental GCP deployment
```

The tag must not precede the client bootstrap: npm requires the package
identity to exist before its trusted publisher can be configured, while the
one-shot bootstrap deliberately requires untagged protected `main`. The
missing npm secret, PyPI publisher configuration and GCP project/billing/DNS
authority are causal external prerequisites. Independent blind-human adoption
and TQ-607 dogfood are explicitly post-alpha evidence and block only their own
human-usability/stable claims. Remote effects remain disabled.

## 1. Outcome

Tasq must become easy to adopt through five progressively broader paths:

1. **Try Local:** run a verified CLI command without cloning the repository.
2. **Install Local:** install, update, back up and uninstall without losing the
   ledger.
3. **Connect an agent:** onboard Codex, Claude Code or an unknown shell/MCP
   agent without requiring repository knowledge.
4. **Embed Tasq:** use a small, documented TypeScript interface without
   reconstructing the kernel composition.
5. **Coordinate across machines:** connect CLI, agents and the authenticated
   Console to one self-hosted or managed Server authority.

The public explanation must lead with the operational problem:

- private runtime todo lists do not tell another runtime who is actively
  working;
- two agents can duplicate work or continue behind an expired owner;
- a crash, model change or handoff can lose execution context;
- GitHub issues are useful external commitments for software work, but do not
  provide domain-neutral expiring claims, attempts, evidence, resource fences
  or cross-runtime recovery;
- a human needs one inspectable ledger of ownership, execution and proof.

The shortest product loop remains:

```text
commitment -> claim -> attempt -> evidence -> explicit completion
```

Runtime-native todo systems remain private execution scratchpads. Tasq owns
only durable shared commitments and coordination. There is no bidirectional
mirroring of every Codex or Claude todo.

## 2. Current baseline and known gaps

| Surface | Current truth | Gap this plan closes |
|---|---|---|
| Public source | Public canonical repository | Keep human and machine truth synchronized |
| npm | Seven `@tasq-run/*@0.3.0` packages published | Present exact, tested acquisition commands |
| Native release assets | Attested macOS ARM64 and Linux x64 assets | Add a user-facing verified installer and explicit runtime/platform table |
| CLI | Broad local command surface | Teach a small journey before the complete reference |
| Local MCP | Capability-scoped stdio transport | Add exact host configuration examples |
| Agent plugins | Codex and Claude Code certified | Add a stable generic-agent entrypoint and project rendezvous contract |
| Local Console | Installed, loopback-only, read-only | Make it visible in onboarding with a real screenshot and start/status commands |
| Embedded Core | Published Bun-oriented TypeScript package | Add a deep local client facade and certify the actual runtime boundary |
| Python | Dependency-free remote source candidate | Publish with provenance and replay the downloaded wheel against the exact Server digest |
| Multi-machine | Online Server plus authenticated offline-replication source candidates | Publish exact artifacts and run a clean-room multi-machine trial |
| Cloud | Private provider-neutral control-plane/BFF source candidate | Bind real infrastructure and pass independent operations/security gates |

The 2026-07-23 audit found the following release-blocking adoption defects:

1. The prefix-based npm installation shown by the site does not put `tasq` on
   `PATH`, while following examples call bare `tasq`.
2. Some rendered multiline command examples contain literal leading `+`
   characters.
3. The homepage onboarding response is illustrative but presented like the real
   `tasq.autonomous-bootstrap.v1` output.
4. The SDK guide calls a `createTasqService` function that
   `@tasq-run/core@0.1.0` does not export.
5. Repository prose still contains pre-publication statements after the
   protected `v0.1.0` release.
6. The homepage explains architecture before demonstrating the concrete
   duplicate-work, ownership, crash and handoff problem.
7. The Local-only rendezvous boundary is not prominent enough beside the
   “shared truth between agents” promise.

These defects are regressions in public truth even though the underlying
release is valid. TQ-609 closes them before another broad product claim.

## 3. Binding sequencing decisions

1. **Adoption repair is complete.** TQ-609 and TQ-610 no longer block the next
   alpha; published-byte and zero-context evidence are retained.
2. **Ship the complete `v0.4.0` public alpha next.** External activation follows
   the checkpoint order above; dogfood and the blind-human session follow the
   alpha rather than delaying it.
3. **Continue TQ-607 in parallel.** Retained dogfood still gates stable
   graduation, but does not block alpha fixes or Server implementation.
4. **Ship an online central Server before offline sync.** Remote CLI and MCP
   first share one live authority. TQ-806 replication follows the deployable
   Server instead of blocking it.
5. **Cloud follows a certified Server.** Cloud initially adds managed
   provisioning and operations, not another kernel or protocol.
6. **Effects remain disabled remotely.** ADR-005 and TQ-612 are complete, but
   TQ-906 still requires TQ-616 published-artifact evidence, the exact deployed
   connector chain and an independent authority/evidence review.
7. **TypeScript remains the reference embedded SDK.** Python first uses CLI
   JSON locally and later receives a remote API client; no second Python kernel
   is planned.
8. **GitHub and task trackers are adapters.** They may map records through
   `external_ref`; they never become an implicit second source of truth.
9. **Simple use stays simple.** The default human journey is
   `add -> list -> done`; the default shared-agent journey is
   `next -> claim -> done`. Attempts, evidence, conditions, effects and
   validation appear only when the selected journey requires them.

### 3.1 GitHub Issues integration boundary

Tasq does not need to replace GitHub Issues for public software collaboration.
The recommended open-source composition is:

- GitHub owns public intake, discussion, labels and contributor discovery;
- Tasq owns active claims, attempts, handoffs, evidence, resource fences and
  cross-runtime recovery;
- one immutable `external_ref` links the Tasq commitment to the issue;
- issue/PR/check/deployment changes enter Tasq as typed observations or
  artifacts;
- closing an issue is evidence or a completion proposal, never automatic
  commitment completion;
- commenting on or closing GitHub from Tasq is an explicit connector effect
  with authority, idempotency and a receipt.

Every integration must declare field-level authority before synchronization.
Supported policies may be GitHub-first, Tasq-first or link-only, but never
unbounded bidirectional last-write-wins. GitHub assignee is durable
responsibility, not a live Tasq claim; a pull request is an artifact, not proof
of completion; a green check can become evidence only through a typed validator
bound to the stated criterion.

For non-code work no GitHub object is required. The same commitment may link to
a CRM case, invoice, document, calendar event, robot run or no external tracker
at all.

## 4. Ordered execution map

| Order | Item | Outcome | Blocks |
|---:|---|---|---|
| 1 | TQ-609 | Public copy, examples and product truth are executable and exact | TQ-606, TQ-610 |
| 2 | TQ-610 | One-command acquisition and universal agent onboarding | TQ-606 |
| 3 | TQ-611 | Real high-level local TypeScript client and runtime contract | SDK claims, TQ-809 |
| parallel after ADR-005 | TQ-612 | Independently validated, contestable completion policies | High-trust completion, TQ-906 |
| 4 | TQ-606 | Independent human completes the public Local adoption journey | Public adoption closure |
| parallel | TQ-607 | Retained three-consumer dogfood and stable decision | Stable graduation |
| 5 | TQ-805 — done | Remote MCP uses the same ADR-004 guard as REST | TQ-807 |
| 6 | TQ-809 — done | Remote CLI/client, enrollment and online workspace rendezvous | TQ-807 |
| 7 | TQ-807 — candidate done | Deployable online Tasq Server artifact and operator lifecycle | TQ-808 |
| 8 | TQ-808 — candidate done | Hostile multi-surface self-host certification | Cloud, offline sync, remote SDKs |
| 9 | TQ-811 — candidate done | Minimal authenticated human action loop over registered Server operations | Daily human/agent collaboration |
| 10 | TQ-812 — candidate done | GitHub Issues, PR, check and deployment bridge with explicit authority | Existing-work adoption |
| 11 | TQ-813 — candidate done | Retry-safe assignment, blocking, expiry, recovery and validation attention loop | Timely coordination |
| 12 | TQ-901–TQ-905 — candidate done | Thin managed Cloud source and hostile operations proof | External managed deployment gates |
| parallel after TQ-808 | TQ-806 — candidate done | Authenticated optional offline replication | Published artifacts and multi-machine trial |
| parallel after TQ-808 | TQ-810 — candidate done | Remote schema and Python client | PyPI/provenance/exact-digest replay |
| last | TQ-906 | Reviewed remote effects, disabled by default until accepted | Remote effect support |

Items in the same “parallel” band may proceed concurrently, but each item keeps
its own dependencies and evidence gate.

## 5. TQ-609 — Public adoption truth and copy repair

**Status:** done

**Depends on:** TQ-603, TQ-604, TQ-605, TQ-704

**Owns:** `apps/site/`, public-facing repository guides, generated site truth

### Required work

- Replace every displayed acquisition and invocation command with an exact
  command that runs outside the repository.
- Remove literal diff markers and formatting artifacts from code examples.
- Generate or fixture the displayed onboarding response from the real CLI
  contract; never hand-maintain a plausible JSON shape.
- Remove the nonexistent `createTasqService` example. Until TQ-611 ships, show
  only real exported Core APIs and state the integration cost honestly.
- Update all remaining pre-publication and candidate-only prose for the current release.
- Lead the homepage with the concrete human/Codex/Claude coordination failure,
  then show the claim/attempt/evidence recovery loop.
- State beside the main promise that Local coordinates processes sharing one
  store on one machine; another machine requires a published Server.
- Add a real Local Console screenshot and the exact `tasq web` /
  `tasq web status` commands.
- Put architecture, product-shape matrices and implementation chronology after
  the use case, working demo and acquisition path.
- Consolidate user-facing category language. Engineering documents may retain
  “universal commitment coordination kernel”; the first public explanation
  should use plain shared-work language.
- Add an explicit supported-platform/runtime table that separates consumer
  requirements from release-publisher toolchain requirements.

### Acceptance

- A clean test executes every command rendered in installation, quickstart,
  agent, MCP, SDK and Console sections.
- Displayed JSON is generated from or schema-checked against the current
  executable contract.
- A test rejects code-block lines accidentally beginning with `+` where they
  are not intentional shell input.
- Site browser tests cover desktop and narrow layouts, keyboard access and the
  real screenshot treatment.
- Repository search finds no statement that packages or protected assets are
  unpublished.
- `pnpm docs:check`, site typecheck, static build and site browser tests pass.

### Evidence

- Owning contract update under `docs/contracts/`.
- Machine-readable certification listing every displayed command and result.
- Browser captures for the full homepage and core onboarding routes.

## 6. TQ-610 — Acquisition lifecycle and universal agent entrypoint

**Status:** done — see
[`TQ-610_RELEASE_CERTIFICATION.json`](../contracts/TQ-610_RELEASE_CERTIFICATION.json)

**Depends on:** TQ-609

**Owns:** release installer, public onboarding routes, CLI agent helpers,
integration guides

### Required work

#### Try without persistent installation

Document and continuously execute both supported package-runner paths:

```bash
bunx @tasq-run/cli@<version> version
npm exec --yes --package=@tasq-run/cli@<version> -- tasq version
```

Never recommend the unrelated unscoped package name.

#### Simple first run

- Provide one explicit human setup command that persists a non-secret space and
  attribution choice, then permits bare `add`, `list` and `done`.
- Keep autonomous-agent onboarding explicit and recipe-driven; do not trade
  safety for a hidden cwd or actor guess.
- Present four progressive levels: simple todo, shared coordination, durable
  execution/proof and external-world coordination.
- Keep advanced commands out of the first-run path while retaining complete
  reference documentation.
- Prove that an assertion-mode todo creates no synthetic claims, attempts,
  evidence or validation records.

#### Persistent install

- Publish a versioned `https://tasq.run/install.sh` backed by repository source.
- Install an executable into an explicit user bin directory such as
  `~/.local/bin`, without silently editing shell startup files.
- Select only a certified platform asset.
- Verify checksum and release provenance before activation.
- Preserve side-by-side activation, backup, rollback and data-preserving
  uninstall semantics from TQ-604/TQ-608.
- Support `--version`, `--prefix`, non-interactive use and a documented
  inspect-before-run flow.
- Explain the Bun dependency honestly until a genuinely self-contained binary
  exists.

#### Generic agent entrypoint

- Serve stable `/SKILL.md`, `/agents`, `/llms.txt` and machine-readable
  integration metadata from the public site.
- Keep Codex and Claude marketplace paths, and add a generic download/copy
  route that does not assume either host.
- Add `tasq agent install codex|claude|generic` or an equivalent deterministic
  helper. It may install instructions/configuration, never hidden authority.
- Add exact MCP host configuration snippets using immutable workspace, actor
  and capability inputs.
- Add an isolated `tasq demo` journey using a temporary home/store. It must
  never discover or mutate a live ledger.

#### Safe project rendezvous

- Define a versioned, non-secret project descriptor for server URL or local
  store rendezvous, workspace ID and agent-instruction URL.
- Require explicit user/project activation; mere current-working-directory
  presence never grants trust, capabilities or effect authority.
- Keep tokens and credentials outside the descriptor.
- For Server, prefer an enrollment link/token that binds endpoint, workspace
  and bounded capabilities; actor attribution remains explicit.

### Acceptance

- Clean macOS ARM64 and Linux x64 environments pass try, install, upgrade,
  backup, rollback and uninstall from only the public entrypoint.
- Uninstall removes installed program files and agent integration files but
  preserves `TASQ_HOME` and every ledger byte.
- One unknown shell agent, Codex and Claude Code each reach the same contention
  and recovery journey without repository prose.
- The automated human-shell proxy completes setup, `add`, `list` and `done`
  without advanced coordination terminology or hand-edited configuration.
  The independent unbriefed-human session remains TQ-606's external gate.
- A hostile repository descriptor cannot widen tool, MCP or effect authority.
- Every public acquisition route is version-pinned or resolves through a
  versioned machine contract.

## 7. TQ-611 — Deep local TypeScript client

**Status:** done — protected `v0.3.0` publication and published-byte replay
passed

**Depends on:** TQ-609

**Owns:** public embedded SDK boundary, package exports and SDK documentation

### Required work

- Decide through the public package-boundary process whether the facade belongs
  in `@tasq-run/core` or a new `@tasq-run/client` package.
- Expose one small composition entrypoint such as:

```ts
const tasq = await createLocalTasq({
  url,
  workspaceId,
  actor,
  clock,
});
```

- Hide database opening, migrations, transaction composition and routine
  administrative initialization behind that interface.
- Preserve explicit identity, workspace and clock; the client must not infer
  them from cwd, global config or ambient credentials.
- Return typed high-level operations for commitments, claims, attempts,
  evidence, resources, inspection and cursors.
- Publish compiled ESM plus declarations, or explicitly retain and document a
  Bun-only contract. Do not claim Node support until Node clean-room tests pass.
- Keep lower-level Core exports available for advanced trusted integrations,
  with a clear stability boundary.
- Generate all SDK documentation examples from executable tests.

### Acceptance

- A fresh consumer project installs only the documented dependency closure.
- One short program runs the canonical loop and survives process restart.
- Node 22 and Bun are either both certified or the unsupported runtime fails
  clearly before state mutation.
- No application needs to call migration internals for the normal path.
- Site, package README and type declarations expose the same API.

### Implementation evidence

The package seam is `@tasq-run/core`; a separate `@tasq-run/client` was
rejected as a shallow pass-through over the same in-process store and kernel.
`createLocalTasq` owns store opening, compatible migrations, space/principal
bootstrap and bound operation context. Generated Core, Schema and Extension
SDK packages now contain compiled ESM plus declarations. Fresh Node 22 and Bun
consumers execute the same generated example twice against one ledger.

Acceptance is recorded in
`../contracts/TQ-611_EMBEDDED_TYPESCRIPT_CLIENT.md` and
`../contracts/TQ-611_RELEASE_CERTIFICATION.json`.
`@tasq-run/core@0.3.0` is published with compiled ESM and declarations; exact
registry bytes pass the Node 22 and Bun fresh-install plus same-ledger restart
journey. CLI, MCP, Console and protocol adapters retain their Bun-only runtime
boundary.

## 8. TQ-612 — Completion validation and dispute policy

**Status:** done — published in `v0.3.0` and exact-byte certified on both
supported native targets

**Depends on:** ADR-005

**Research input:** [`../research/PREDICTION_MARKET_ORACLES_FOR_TASQ.md`](../research/PREDICTION_MARKET_ORACLES_FOR_TASQ.md)

Tasq currently provides evidence-backed, attributable completion. Its
`evidence-required` policy verifies that named evidence belongs to the
commitment and has not been superseded; the completing principal still decides
whether that evidence semantically satisfies the success criteria.

TQ-612 introduces independently validated completion without making one
universal validator:

- freeze criterion identities, accepted evidence/source types, eligibility
  time, edge-case behavior, validator profile and challenge policy against one
  commitment revision;
- separate append-only evidence, completion proposal, validation decision and
  final completion record;
- support deterministic extension evaluation, named independent attestation,
  optimistic challenge windows and explicit adjudication;
- represent `accepted`, `rejected`, `too_early`, `indeterminate` and
  `challenged`; only `accepted` may finalize `done`;
- forbid silent success when sources are stale, unavailable or contradictory;
- preserve current assertion/evidence behavior as the explicit low-assurance
  compatibility policies;
- keep financial bonds and token voting outside Core. They may be added only by
  a future marketplace policy.

Acceptance attacks criterion changes after work starts, self-validation,
colluding validators, stale sources, contradictory evidence, late challenges,
reviewer revocation and lost decision responses. CLI, Console, MCP and Server
must expose the complete resolution chain without treating validator prose as
code or authority.

## 9. TQ-606 and TQ-607 — External learning gates

TQ-606 is rerun only after TQ-609 and TQ-610. The unbriefed participant starts
at `https://tasq.run`, installs Tasq, connects an agent, resolves a contention
case and opens the same ledger in the Console. Every intervention and failure
is recorded; coaching invalidates independence but still produces a finding.

TQ-607 continues in parallel on retained private ledgers. It gates stable
graduation, not implementation of the public-alpha repair or Server. Every
workaround discovered through dogfood is classified as:

- documentation/copy defect;
- acquisition or upgrade defect;
- product interaction defect;
- missing kernel invariant;
- missing remote/server capability;
- adopter-specific policy that stays outside Core.

No synthetic test can replace its minimum duration or maintainer decision.

## 10. TQ-805 — Guarded remote MCP

**Status:** done — host-integrated surface only

**Depends on:** TQ-804

`createHostedMcpHandler` now authenticates each exact Streamable HTTP request,
discards raw credentials before tool dispatch and projects bounded read tools
plus one collision-checked tool per registered mutation operation through the
same TQ-803/TQ-804 handler. Tool presence is never authority; every call uses
the same subject binding, workspace router, live decision, idempotency and
request-wide injected time as REST.

The official MCP client and clean-room eval prove exact replay, conflicting
key denial, immediate revocation and foreign-workspace isolation. V1 is
stateless and retains Tasq event cursors as its durable resume mechanism.
Remote effects, listeners, concrete verifiers and deployable Server lifecycle
remain absent. Evidence is frozen in
`../contracts/TQ-805_REMOTE_MCP_CERTIFICATION.json`.

## 11. TQ-809 — Remote CLI, client and enrollment

**Status:** done — repository-certified source candidate; not in published `v0.3.0`

**Depends on:** TQ-804, TQ-611

**Owns:** the first supported multi-machine user journey

### Required work

- Freeze a versioned remote API/client contract over the guarded REST surface.
- Add a remote CLI profile that selects an explicit endpoint and workspace and
  obtains identity through enrollment; it must never reinterpret an actor label
  as authentication.
- Add a runtime-neutral TypeScript remote client with the same high-level
  operation vocabulary as TQ-611 where semantics match.
- Implement expiring, bounded, one-use enrollment for human devices and
  workload agents, with recovery and revocation.
- Add event streaming/resume with exclusive cursors and explicit cursor-expiry
  recovery.
- Define local credential storage, permissions, rotation and logout.
- Keep online Server authority central: no direct remote database credentials,
  shared SQLite folder or client-side authority cache.

### Acceptance

- Two clean machines enroll into one workspace and resolve real claim/resource
  contention through the Server.
- Revocation takes effect for the next guarded operation and stale clients
  cannot mutate or renew authority.
- A lost response is safely retried with the same identity.
- CLI, REST and MCP inspect the same canonical records and cursors.
- Removing local client state does not delete server data.

### Implementation evidence

`@tasq-run/client` is a Fetch-only package candidate with no Core or database
dependency. `tasq remote` owns explicit named profiles and private credential
files. The authority store owns one-use enrollment and revocable opaque
credential digests; every subsequent request still crosses the live ADR-004
guard. Two clean clients pass claim/resource contention, exact lost-response
replay, next-request revocation and REST/official-MCP cursor parity.

See
[`TQ-809_REMOTE_CLIENT_AND_ENROLLMENT.md`](../contracts/TQ-809_REMOTE_CLIENT_AND_ENROLLMENT.md)
and
[`TQ-809_REMOTE_CLIENT_CERTIFICATION.json`](../contracts/TQ-809_REMOTE_CLIENT_CERTIFICATION.json).
Those pieces were deliberately absent from TQ-809 itself. TQ-807 now supplies
them as a separate unpublished Server source candidate.

## 12. TQ-807 — Deployable online Tasq Server

**Status:** source candidate complete; publication and operator gates open

**Depends on:** TQ-805, TQ-809

**Important change:** authenticated offline replication no longer blocks the
first deployable online Server.

### Required work

- Ship one supported daemon/container entrypoint with an HTTPS deployment
  contract.
- Provide at least one concrete standards-based credential verifier and strict
  issuer/audience/token configuration.
- Package authority store migrations, workspace routing and guarded domain
  operations.
- Expose health, readiness, version, support metadata and bounded metrics.
- Provide Docker image and Compose reference deployment.
- Define durable storage volumes, backup, restore, upgrade, rollback and
  disaster-recovery procedures.
- Publish operator configuration schemas and secret boundaries.
- Supply an authenticated hosted read-only Console through a same-origin BFF;
  never expose the Local loopback trust model.
- Keep provider connectors and remote effects disabled by default and outside
  the image unless explicitly configured.

### Acceptance

- A clean host follows only public self-hosting documentation.
- Upgrade and matching-backup rollback preserve retained workspaces.
- Restart, process kill and network interruption preserve mutation identity and
  cursor recovery.
- Default configuration fails closed and binds no unsafe anonymous mutation
  route.
- Image provenance, SBOM, checksums and version compatibility are published.

## 13. TQ-808 — Self-hosted hostile certification

**Status:** repository hostile candidate complete; published-image,
cross-platform clean-room and unbriefed-operator gates open

TQ-808 closes only when the packaged Server, rather than an in-process handler,
passes:

- two independent issuers;
- cross-workspace identifier probing and storage-routing denial;
- live grant/delegation revocation races;
- stolen, expired, wrong-audience and malformed credential tests;
- REST/MCP/CLI parity and confused-deputy attempts;
- restart, restore, upgrade and old-backup recovery;
- macOS/Linux client clean rooms against a Linux deployment;
- bounded event streaming, cursor expiry and support-bundle redaction;
- a previously unbriefed operator deployment.

Only this gate may change Server from an unpublished source candidate to a
shipped self-hostable product.

## 14. TQ-613–TQ-616 — Purpose-bound signed statements

**Status:** ADR-009 accepted; TQ-613–TQ-615 complete in source; TQ-616
protected-artifact and unbriefed-agent gates open

**Depends on:** TQ-802, TQ-808, TQ-612, TQ-205 and TQ-405

The signed-statement program adds portable principal authorship after the first
Server is hostile-certified. It does not delay the initial online Server and it
does not make signatures mandatory for simple Local commitments.

- TQ-613 freezes the canonical payload, typed DSSE-style envelope, baseline
  Ed25519 profile, purpose registry and cross-language verification vectors.
- TQ-614 adds authority-owned public signing credentials, proof-of-possession
  enrollment, isolation classes, rotation, suspension, revocation, compromise,
  retirement, recovery and purpose-constrained signer/verifier interfaces.
- TQ-615 persists append-only statements and verification records and binds
  them through typed services to artifacts, completion resolution, effect
  approvals, replication operations and workspace checkpoints. It integrates
  Core, CLI, MCP, Console, doctor, backup and portable data without exposing
  private keys or an arbitrary-byte signing oracle.
- TQ-616 runs hostile cross-surface, cross-language, revocation-race,
  migration, restore and published-byte certification.

Acceptance preserves five independent questions:

1. do the bytes match their digest;
2. did the credential sign the exact purpose-bound statement;
3. was that credential bound to the principal at acceptance;
4. was the principal authorized or eligible for this action;
5. did the statement actually satisfy the semantic policy.

The full design and threat matrix are
[`TQ-613_SIGNED_STATEMENT_ARCHITECTURE.md`](../contracts/TQ-613_SIGNED_STATEMENT_ARCHITECTURE.md)
and
[`SIGNED_STATEMENT_ACCEPTANCE.json`](../contracts/SIGNED_STATEMENT_ACCEPTANCE.json).

## 15. TQ-806 — Optional authenticated offline replication

**Status:** source candidate complete; published Server/client and clean-room
multi-machine gates open

**Depends on:** TQ-405, TQ-808, TQ-616

Offline replication is an enhancement to a working online authority, not the
first multi-machine transport.

- Enroll and rotate replica identities.
- Authenticate push, pull, snapshot and recovery channels.
- Preserve explicit operation order, tombstones, conflict visibility and
  cursor-retention semantics.
- Prevent an offline replica from extending expired claims, resource leases,
  approvals or effect authority.
- Require online reacquisition of live authority before protected I/O.
- Provide operator-visible conflict and rebase workflows.
- Certify long disconnect, malicious reorder/duplication, stale backup and
  authority-epoch rotation.

## 16. TQ-901–TQ-905 — Thin managed Cloud alpha

**Status:** source candidates complete; deployed operations gates open

Cloud operates the same Server contracts. The initial alpha includes:

- isolated workspace provisioning;
- human-device and agent enrollment;
- same-origin authenticated read-only Console;
- quotas and retention;
- export, deletion and workspace recovery;
- key rotation, audit and restricted support access;
- service health, incident and backup operations.

The initial alpha excludes:

- remote effects;
- provider credential custody;
- marketplace or extension execution;
- complex organizations and enterprise roles;
- billing until usage and support behavior are understood;
- offline replication as a launch dependency.

Cloud acceptance requires multi-tenant isolation, restore drills, complete
export/delete behavior, revocation and support-access audit. A deployment URL
or successful demo is not sufficient.

The repository source candidate now implements and tests every listed
control-plane boundary except service health, which remains the exact Server
runtime health contract rather than a second Cloud truth. The hostile fixture
covers two-tenant isolation, a concurrent quota race, sessions/CSRF/origin,
device/recovery/tenant revocation, provisioning recovery, export, retention,
backup/restore, credential-reference rotation, support expiry/revocation,
incident/billing separation and deletion retry. See TQ-901 through TQ-905 in
`../contracts/`.

This does not satisfy Cloud acceptance by itself. Real provider bindings,
secret-manager rotation, off-site restore, region failover, protected deployed
artifacts, independent security review and an unbriefed operator incident drill
remain external gates. Consequently `managedCloudAvailable` remains false.

## 17. TQ-810 — Remote cross-language SDKs

**Status:** source candidate complete; publication gate open

**Depends on:** TQ-808, TQ-616

- Publish the stable remote API schema/OpenAPI document.
- Generate a client conformance suite from protocol examples and failure
  vectors.
- Ship a supported Python client first because local Python users currently
  have only CLI JSON.
- Keep remote clients thin: no local kernel reimplementation, schema migration
  or second source of truth.
- Add other language clients only in response to demonstrated adopters.

Before TQ-810, Python documentation shows `subprocess` plus `--json`, argument
arrays, explicit space/actor, typed error handling and cursor persistence. It
must not concatenate ledger prose into a shell command.

## 18. Verification matrix

| Change type | Minimum focused checks | Handoff gate |
|---|---|---|
| Public copy/examples | site unit/static/browser tests; execute displayed commands | `pnpm verify:handoff` |
| Installer/release | two certified target clean rooms; checksum/attestation; lifecycle | protected CI certificate |
| Agent integration | isolated home; real host install/use/uninstall; hostile instructions | machine certificate plus blind trial |
| Local SDK | fresh consumer package; Bun/Node matrix; restart/data retention | package clean-room certificate |
| Remote transport | cross-workspace, revocation, idempotency, cursor and clock tests | hostile multi-surface eval |
| Signed statements | canonical/signature vectors, key lifecycle, purpose isolation, revocation race, no-secret scan | hostile cross-language and published-byte certificate |
| Server artifact | clean deployment, backup/restore/upgrade/rollback, SBOM | protected image and operator trial |
| Cloud | tenancy, deletion/export, key rotation, incident/restore, support audit | independent operational review |
| Offline replication | loss/reorder/duplicate/conflict/expiry/old-backup tests | chaos and recovery certificate |

Every completed item also updates:

1. the owning implementation and tests;
2. its human contract and machine certificate;
3. `CURRENT_STATE.md`;
4. `PRODUCT_CONSUMPTION_SPEC.md` and `PRODUCT_SURFACE_MATRIX.json`;
5. `BACKLOG.json` and `BACKLOG.md`;
6. affected site, root and package documentation.

## 19. Definition of done for the program

The program is complete when:

- every command displayed publicly is executable and continuously tested;
- a human can try, install, inspect, update and uninstall Local without
  repository knowledge or data loss;
- Codex, Claude Code and an unknown agent can discover the same shared-work
  contract without mirroring their private todo systems;
- the embedded TypeScript API shown publicly exists and has a certified runtime
  boundary;
- two machines can coordinate against one authenticated self-hosted Server;
- one managed Cloud workspace can be provisioned, recovered, exported and
  deleted without changing kernel semantics;
- optional offline clients cannot retain stale authority;
- unsupported platforms, runtimes, SDKs, effects and product shapes remain
  explicit rather than implied;
- independent human, operator and retained-data evidence is recorded where
  simulation cannot establish usability or operational safety.
