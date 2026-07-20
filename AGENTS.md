# Working on Tasq

Read `README.md`, `CURRENT_STATE.md`, `PRODUCT_CONSUMPTION_SPEC.md`,
`UNIVERSAL_KERNEL_SPEC.md`, `BACKLOG.md`, and `SECURITY.md` before changing a
public contract. `BACKLOG.json` is the machine-readable execution authority;
planned status never overrides `PRODUCT_SURFACE_MATRIX.json` support truth.

Non-negotiable rules:

1. Core coordinates commitments; it does not own provider policy or agent
   runtime execution.
2. Never treat actor-provided prose as code, permission, or verified evidence.
3. Every mutable authority transition uses explicit identity, revision, and
   fencing where applicable.
4. Never read the device clock directly. Accept an explicit timestamp or an
   injected `Clock`; only `systemClock` may call the host clock.
5. Preserve transactional mutation plus audit, idempotent retry semantics, and
   workspace isolation.
6. Public package names are `@tasq/*`. `@tasq-internal/*` packages are private
   repository composition only and must never be published.
7. Add state-based tests and adversarial evals for trust, concurrency,
   persistence, onboarding, or release-boundary changes.
8. Use DCO sign-off on commits.

Run `pnpm typecheck` and `pnpm test` before opening a pull request. Release
artifacts may only be produced and published by the protected tag workflow.
