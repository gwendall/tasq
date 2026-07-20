# Contributing to Tasq

Tasq welcomes focused bug fixes, documentation improvements, conformance
vectors and primitives backed by real cross-domain failures.

Before changing code:

1. Read `AGENTS.md`, `CURRENT_STATE.md` and the relevant ADR.
2. Classify the failure as kernel invariant, policy, connector, runtime or
   presentation work.
3. Keep provider credentials, workflow execution and domain policy out of the
   kernel.
4. Add tests that prove the invariant, including retries/races when relevant.
5. Run `bun test` from the Tasq root.

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
a universal kernel primitive.
