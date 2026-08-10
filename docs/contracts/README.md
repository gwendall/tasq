# Engineering contracts

`TQ-*` documents bind one feature, safety property, or acceptance gate to its
implementation evidence. JSON files beside them are machine-readable
certificates or status snapshots.

| Range | Area |
|---|---|
| 100 | Generic commitment inspection |
| 200 | Effects, authority, receipts, and adversarial safety |
| 300 | MCP, connectors, protocol surfaces, and agent integration |
| 400 | Outbox, idempotency, replication, and recovery |
| 500 | Bounded context, compaction, links, and read-first inspection |
| 600 | Public repository, releases, adoption, dogfood, data safety, completion resolution, and signed-statement trust |
| 700 | Local Console models, transport, UI, lifecycle, and browser proof |
| 800 | Hosted authority, REST, remote MCP, remote clients/enrollment, Server and authenticated offline replication |
| 900 | Managed Cloud control plane, BFF, identity, operations and independent remote-effect gate |

Current Server entrypoint: [`TQ-807_DEPLOYABLE_SERVER.md`](TQ-807_DEPLOYABLE_SERVER.md);
machine evidence: [`TQ-807_SERVER_CERTIFICATION.json`](TQ-807_SERVER_CERTIFICATION.json).
Hostile packaged evidence: [`TQ-808_SELF_HOSTED_HOSTILE_CERTIFICATION.md`](TQ-808_SELF_HOSTED_HOSTILE_CERTIFICATION.md).
Signed-statement integration and hostile source evidence:
[`TQ-615_SIGNED_STATEMENT_INTEGRATION.md`](TQ-615_SIGNED_STATEMENT_INTEGRATION.md)
and [`TQ-616_SIGNED_STATEMENT_CERTIFICATION.md`](TQ-616_SIGNED_STATEMENT_CERTIFICATION.md).
Provider-neutral attestation lifecycle and eligibility semantics:
[`TQ-625_ATTESTATIONS.md`](TQ-625_ATTESTATIONS.md).
Readable mandates compiled to existing live authority:
[`TQ-626_MANDATES.md`](TQ-626_MANDATES.md).
Exact multi-party agreements and reciprocal commitment compilation:
[`TQ-627_AGREEMENTS.md`](TQ-627_AGREEMENTS.md).
Settlement and recourse over exact agreement, attempt and resolution facts:
[`TQ-628_SETTLEMENT_RECOURSE.md`](TQ-628_SETTLEMENT_RECOURSE.md).
Authenticated offline replication and Python remote SDK:
[`TQ-806_AUTHENTICATED_OFFLINE_REPLICATION.md`](TQ-806_AUTHENTICATED_OFFLINE_REPLICATION.md)
and [`TQ-810_REMOTE_SDKS.md`](TQ-810_REMOTE_SDKS.md).
Managed Cloud begins with
[`TQ-901_MANAGED_CLOUD_CONTROL_PLANE.md`](TQ-901_MANAGED_CLOUD_CONTROL_PLANE.md);
its hostile source certificate is
[`TQ-905_MANAGED_CLOUD_HOSTILE_CERTIFICATION.md`](TQ-905_MANAGED_CLOUD_HOSTILE_CERTIFICATION.md),
while remote effects remain behind
[`TQ-906_REMOTE_EFFECTS_REVIEW_GATE.md`](TQ-906_REMOTE_EFFECTS_REVIEW_GATE.md).
The provider-neutral external-gate manifest and schema are
[`MANAGED_CLOUD_PRODUCTION_READINESS.template.json`](MANAGED_CLOUD_PRODUCTION_READINESS.template.json)
and
[`MANAGED_CLOUD_PRODUCTION_READINESS.schema.json`](MANAGED_CLOUD_PRODUCTION_READINESS.schema.json);
their operating procedure is in
[`../guides/MANAGED_CLOUD_PRODUCTION_READINESS.md`](../guides/MANAGED_CLOUD_PRODUCTION_READINESS.md).

Start from the owning concept, guide, or roadmap item rather than reading this
directory sequentially. Current release blockers are listed in
[`../roadmap/BACKLOG.md`](../roadmap/BACKLOG.md).
