# Architecture decisions

ADRs record accepted cross-cutting decisions. Read one when changing its
boundary; they are not required for a first product evaluation.

| Decision | Boundary |
|---|---|
| [`ADR-002`](ADR-002_EFFECT_REQUEST_IDENTITY.md) | Canonical effect request identity and retry semantics |
| [`ADR-003`](ADR-003_REPLICA_CONFLICT_MODEL.md) | Replica ordering, conflicts, tombstones, and cursor retention |
| [`ADR-004`](ADR-004_AUTHENTICATED_HOSTED_TENANCY.md) | Hosted identity, authorization, isolation, and deployment boundary |
| [`ADR-005`](ADR-005_EVIDENCE_TRUST_AND_RESOLUTION.md) | Evidence authenticity, revocation, retention, and independently validated completion |
| [`ADR-006`](ADR-006_MACHINE_DISCOVERY_ONBOARDING.md) | Machine discovery and capability negotiation |
| [`ADR-007`](ADR-007_PROTOCOL_TASK_ADAPTERS.md) | MCP Tasks and A2A mappings |
| [`ADR-008`](ADR-008_PUBLIC_RELEASE_GOVERNANCE.md) | Name, license, packages, governance, and release provenance |
| [`ADR-009`](ADR-009_SIGNED_STATEMENTS_AND_CREDENTIALS.md) | Accepted purpose-bound signatures, credential lifecycle, and trust separation |
| [`ADR-010`](ADR-010_REMOTE_CLIENT_AND_ENROLLMENT_BOUNDARY.md) | Remote client package, one-use enrollment, credential storage, and logout boundary |
| [`ADR-011`](ADR-011_TARGET_REFERENCE_AND_BINDINGS.md) | Portable external-target identity and deterministic bindings into existing records |
| [`ADR-012`](ADR-012_TRUSTED_STATEMENT_BINDER_REGISTRY.md) | Open signed-purpose descriptors paired with trusted host binder implementations |
| [`ADR-013`](ADR-013_ATTESTATION_TRUST_AND_ELIGIBILITY.md) | Provider-neutral assertions, append-only revocation, temporal eligibility and trust separation |
| [`ADR-014`](ADR-014_MANDATES_COMPILE_TO_AUTHORITY.md) | Readable mandates compile to existing grants and delegations without a second authority truth |
| [`ADR-015`](ADR-015_EXACT_AGREEMENTS_COMPILE_TO_COMMITMENTS.md) | Exact multi-party consent compiles atomically to reciprocal commitments and resolution policy |
| [`ADR-016`](ADR-016_SETTLEMENT_IS_A_NEW_DECISION.md) | Settlement and recourse create new obligations without rewriting completion or bypassing effect authority |
| [`ADR-017`](ADR-017_CUSTODY_IS_AN_EXPERIMENTAL_LINEAGE.md) | Exclusive custody handoff lineage remains a private experimental Module, distinct from leases, observations and authority |
| [`ADR-UK-006`](ADR-UK-006_COLLABORATION_RECORDS.md) | Universal collaboration records |
| [`ADR-UK-EXT`](ADR-UK-EXT_EXTENSION_REGISTRY.md) | Extension identity, registry, and trust |
| [`ADR-020`](ADR-020_KERNEL_DISCOVERY_CAPTURE.md) | Discovery capture as a kernel operation reachable from every agent surface |
