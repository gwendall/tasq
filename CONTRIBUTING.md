# Contributing to Tasq

Tasq welcomes focused bug fixes, documentation improvements, conformance
vectors and primitives backed by real cross-domain failures.

Start with [DEVELOPMENT.md](docs/guides/DEVELOPMENT.md). It contains the canonical checkout
check, repository map, task-selection rules, focused commands and definition of
done. Agents must also follow [AGENTS.md](AGENTS.md).

Before changing code:

1. Read [CURRENT_STATE.md](docs/concepts/CURRENT_STATE.md) and the contract or ADR that owns
   the behavior.
2. Classify the failure as kernel invariant, policy, connector, runtime,
   product surface or presentation work.
3. Keep provider credentials, workflow execution and domain policy out of the
   kernel.
4. Add tests that prove the invariant, including retries and races when
   relevant.
5. Update human documentation and machine-readable product truth together.
6. Run `pnpm docs:check`, `pnpm typecheck` and `pnpm test` from the repository
   root.

Every commit contributed for inclusion must carry a Developer Certificate of
Origin sign-off:

```text
Signed-off-by: Your Name <your-email@example.com>
```

Use `git commit -s`. By signing off, you certify the Developer Certificate of
Origin 1.1 at <https://developercertificate.org/>. Do not contribute secrets,
live ledger contents, proprietary fixtures or assets you cannot redistribute.

Public API, persistence, trust-boundary, license, governance and release-policy
changes require an ADR. A useful feature for one adopter is not automatically
a universal kernel primitive. Publishing packages, creating release tags,
changing repository visibility or changing external registry configuration
also requires explicit maintainer authorization; passing local tests is not
publication authority.
