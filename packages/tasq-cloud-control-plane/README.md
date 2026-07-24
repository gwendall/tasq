# `@tasq-internal/cloud-control-plane`

Provider-neutral source candidate for operating Tasq Server as a managed
multi-tenant service. It is private because no managed Tasq Cloud deployment
is currently offered.

The package owns tenant/workspace lifecycle, quotas, human sessions, workload
and device revocation, export/delete, backup/restore, credential-reference
rotation, restricted support access, incident/billing records and the
same-origin browser BFF. Every administrative mutation calls a host-injected
authorization decision before state changes.

It does **not** contain Core domain semantics, provider credentials, raw
identity subjects, raw browser tokens, a billing entitlement shortcut or a
remote effect route. Provisioning secrets are opaque secret-manager
references. The BFF exchanges an HttpOnly session for a Server credential
inside the trusted process and strips cookies and downstream `Set-Cookie`.

```bash
pnpm --filter @tasq-internal/cloud-control-plane typecheck
bun test packages/tasq-cloud-control-plane/test/cloud.test.ts
```

See `docs/contracts/TQ-901_MANAGED_CLOUD_CONTROL_PLANE.md` through
`docs/contracts/TQ-906_REMOTE_EFFECTS_REVIEW_GATE.md`.
