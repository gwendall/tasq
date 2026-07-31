# Managed Cloud production readiness

This runbook turns the external gates of TQ-901 through TQ-905 into one
provider-neutral, fail-closed evidence manifest. It prepares a deployment for
maintainer review; it does not select a provider, deploy Tasq, approve its own
security review or make Tasq Cloud available.

The normative machine files are:

- [`MANAGED_CLOUD_PRODUCTION_READINESS.schema.json`](../contracts/MANAGED_CLOUD_PRODUCTION_READINESS.schema.json)
  — portable JSON Schema;
- [`MANAGED_CLOUD_PRODUCTION_READINESS.template.json`](../contracts/MANAGED_CLOUD_PRODUCTION_READINESS.template.json)
  — deliberately incomplete starting point;
- [`validate-managed-cloud-readiness.ts`](../../scripts/validate-managed-cloud-readiness.ts)
  — deterministic semantic validator.

The manifest never grants domain, administrative or effect authority.
`managedCloudAvailable`, `remoteEffectsEnabled` and
`manifestGrantsAuthority` must remain `false`, including after every readiness
gate passes. Publication and product-truth changes are separate, explicitly
authorized maintainer actions. TQ-906 remains a separate independent review.

## Evidence custody

Copy the template into the deployment's protected evidence system. Do not
check live deployment manifests into this repository. The checked-in template
contains no provider choice, credential, private endpoint or operational
evidence.

Use only:

- exact `registry/name@sha256:...` Server image coordinates;
- exact lowercase source commits and `sha256:` candidate digests;
- opaque `urn:tasq-provider:...` references for provider-owned resources;
- immutable `urn:sha256:...`, protected `https://...` or
  `evidence/cloud/...` references for evidence.

Never put a database URL, access token, cookie, private key, recovery code,
identity subject, raw secret-manager reference value or workstation path in
the manifest. Evidence URLs cannot contain user information, query strings or
fragments because those are common credential-bearing channels.

## Efficient execution order

1. **Freeze exact candidates.** Record the source commit, control-plane digest,
   protected Server image coordinate and provenance. The coordinate digest and
   separately recorded image digest must match.
2. **Provision the authority boundary.** Bind the production database, secret
   manager, deployment identity, canonical HTTPS origin, TLS/CSP policies and
   at least two distinct region references. Resource identifiers remain opaque.
3. **Exercise identity and browser boundaries.** Run the real OIDC callback,
   logout, device revocation, recovery revision, workload issuance and deployed
   browser matrix. Prove the browser never receives the Server credential and
   `/effects` remains denied.
4. **Exercise lifecycle and recovery.** Run backup/restore, off-site restore,
   region failover, credential-reference rotation, export, verified byte
   deletion, support-access expiry/revocation and an incident drill using the
   stable operation IDs defined by TQ-904.
5. **Obtain independent evidence.** A reviewer independent of the implementation
   must cover the multi-tenant infrastructure and web boundary. A previously
   unbriefed operator must execute the incident drill. Record reviewer evidence,
   not a name or self-attested boolean.
6. **Request maintainer decision.** Only when every gate is `passed`, every
   readiness field is populated and validation succeeds may `state` become
   `ready_for_maintainer_decision`. Availability still remains false until the
   maintainer explicitly authorizes the corresponding product-truth change.

Failed drills are evidence too: use `failed`, an explicit injected/recorded UTC
instant and immutable evidence references. Fix the system and append a new
protected evidence artifact before changing the gate to `passed`; do not edit
or erase the original failure record.

## Gate map

| Ticket | Required external proof |
|---|---|
| TQ-901 | Production database; secret-manager plus exact Server digest; independent multi-tenant infrastructure review |
| TQ-902 | Deployed browser matrix; real identity callback/logout; independent web security review |
| TQ-903 | Real OIDC; workload secret issuance; recovery and revocation drill |
| TQ-904 | Provider backup/restore; key rotation; export and verified deletion; on-call incident/support drill |
| TQ-905 | Exact artifact deployment; off-site restore and region failover; independent multi-tenant security review; unbriefed-operator incident drill |

The reliability section additionally requires a non-trivial production
availability target of at least 99%, an explicit 28–366 day measurement
window, RPO, RTO, SLO evidence and disaster-recovery evidence. This is a
readiness floor, not a Tasq service promise. These are deployment claims and
cannot be inferred from repository tests.

## Validation

Structural validation of the checked-in open template succeeds and reports all
missing external evidence:

```bash
bun scripts/validate-managed-cloud-readiness.ts
```

Validate an evidence manifest without copying it into the repository:

```bash
bun scripts/validate-managed-cloud-readiness.ts \
  --manifest /protected/evidence/cloud-readiness.json
```

Gate a deployment decision:

```bash
bun scripts/validate-managed-cloud-readiness.ts \
  --manifest /protected/evidence/cloud-readiness.json \
  --require-ready
```

Exit codes are deterministic:

- `0`: structurally valid, and ready when `--require-ready` was requested;
- `1`: invalid JSON, unsafe material, drift, contradiction or schema-semantic
  failure;
- `2`: valid evidence structure, but one or more external readiness gates are
  still open.

The validator reads no device clock and makes no network request. It validates
only the submitted bytes; an independent reviewer must still verify that each
referenced artifact is authentic and corresponds to the deployed coordinates.

## Fail-closed handoff

Before asking to change product truth:

1. run the validator with `--require-ready`;
2. independently resolve every evidence reference and match exact digests;
3. confirm the deployed image is the protected TQ-807/TQ-905 coordinate;
4. confirm remote effects are still disabled;
5. preserve failed and superseded drill evidence;
6. update the owning TQ contracts, machine certificates, surface matrix and
   roadmap together only under explicit maintainer authorization.

A locally green source suite, a complete manifest, a reachable HTTPS origin or
a provider dashboard screenshot is not by itself a production certification.
