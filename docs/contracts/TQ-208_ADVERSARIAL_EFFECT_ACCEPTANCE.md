# TQ-208 — Adversarial effect acceptance

> **Status:** passed — 2026-07-16  
> **Scope:** black-box acceptance of the complete generic effect boundary across
> four unrelated write domains, using only public kernel and connector-SDK APIs.

## Decision

M2's effect, authority and receipt semantics pass the adversarial gate defined
by `TQ-201_EFFECT_AUTHORITY_THREAT_MODEL.md`. The proof is executable in
`packages/tasq-evals/effect-authority-adversarial.test.ts` and changes no kernel
schema or behavior for any domain.

The eval supplies a small in-memory provider only to model the independent
system boundary. It enforces one provider operation per dispatch key and rejects
parameter drift. Tasq still performs no provider network I/O.

## Accepted vectors

| Vector | Executable result |
|---|---|
| Money | Amount, recipient and provider-account mutation invalidate the authenticated permit. Repeating the exact permit yields one provider operation. |
| Important communication | BCC, header and attachment mutation fail before I/O. A lost response becomes `indeterminate`; authenticated lookup resolves the same operation. |
| Destructive filesystem | Traversal, wrong root and changed target/symlink binding fail. A restore is only a new proposed compensation; deletion history remains committed. |
| Deployment | Artifact digest, environment and account mutation fail under exact scope. |
| Approval races | Exclusive expiry is deterministic; denial and revocation cannot dispatch; concurrent cancellation/dispatch has exactly one winner. |
| Crash matrix | Before intent, after `executing`, after provider commit and after receipt/retry never produce a second provider operation. |
| Receipt attacks | Weak, insufficiently covered, forged, wrong-account, replay-conflicting and cross-workspace reports cannot commit an effect. |
| Isolation | Foreign workspace effect, approval and claim identities fail even when valid records exist elsewhere. |
| Clock purity | One mutable controlled `Clock` drives the complete suite; a production-source scan finds no ambient wall/monotonic time outside `systemClock`. |

## Observable guarantees

- The provider idempotency boundary and Tasq ledger retry boundary agree on the
  same immutable dispatch identity.
- No protected mutation can be smuggled through a signed permit.
- `executing` is not success, timeout is not failure, receipt is not commitment
  completion, and compensation is not erasure.
- Canonical inspection exposes both uncertainty and recovery receipts in order.
- The final store passes `doctor` after crash/recovery scenarios.
- All four domains use the same tables and public services; only pure connector
  policies and data differ.

## Residual boundary

This proof does not make an arbitrary connector trustworthy. Production hosts
still need least-privilege credentials, provider-specific receipt verification,
safe idempotency horizons, origin/audience controls and remote identity/key
management. These belong to connector conformance and deployment policy, not
the commitment kernel.

## Result

TQ-201 through TQ-208 are complete. M2's effect/authority acceptance gate is
closed. The next product step is TQ-305: freeze the reusable connector
conformance contract before exposing effect-capable remote tools or shipping a
reference write connector.
