# TQ-906 — Remote effects independent review gate

> **Status:** blocked on independent authority review and deployed evidence
> **Date:** 2026-08-12
> **Machine gate:** `TQ-906_REMOTE_EFFECTS_REVIEW_GATE.json`

ADR-005, TQ-612 and the published signed-statement stack define important
ingredients, but none of them grants remote effect authority. Completion
evidence, a valid signature, tenant membership, an ordinary Server grant,
billing status, support access and a browser session are all insufficient.

The current Server runtime reports `effectsEnabled: false`. Remote operation
catalogs do not register a dispatch operation. The Cloud BFF rejects every
`/effects` path before obtaining a Server credential. This fail-closed state is
the release invariant.

Enabling remote effects requires all of the following:

1. the TQ-205/TQ-206 connector permit, fence, receipt, uncertainty and
   compensation chain composed through the exact deployed Server digest;
2. tenant/workspace/principal/credential/action binding in one live authority
   decision immediately before I/O;
3. revocation and credential-compromise races against real connectors;
4. an independent reviewer who did not author the implementation approving
   both evidence trust and effect authority;
5. protected deployment evidence, rollback and incident response.

The current agent cannot independently review its own implementation.
Therefore TQ-906 remains open and remote effects remain disabled.
