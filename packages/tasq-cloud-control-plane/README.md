# `@tasq-internal/cloud-control-plane`

Provider-neutral source candidate for operating Tasq Server as a managed
multi-tenant service. It is private because no managed Tasq Cloud deployment
is currently offered.

The package owns tenant/workspace lifecycle, quotas, human sessions, workload
and device revocation, export/delete, backup/restore, credential-reference
rotation, restricted support access, incident/billing records and the
same-origin browser BFF. Every administrative mutation calls a host-injected
authorization decision before state changes.

The control database is an explicit connection object. Local development uses
a credential-free `file:` URL; a managed deployment may supply a separate
`libsql:`/`https:` URL and bearer token. URLs containing credentials, query
parameters or fragments fail closed. The create-only migration tools produce
secret-free content fingerprints without deleting or replacing the source:

```bash
pnpm --filter @tasq-internal/cloud-control-plane snapshot:database -- \
  <destination.sqlite> <observed-at-rfc3339> <opaque-source-ref>
pnpm --filter @tasq-internal/cloud-control-plane verify:database -- \
  <snapshot.sqlite> <observed-at-rfc3339> <source-ref> <target-ref>
```

The second command reads the remote URL and token only from
`TASQ_CLOUD_DATABASE_URL` and `TASQ_CLOUD_DATABASE_AUTH_TOKEN`. These source
capabilities are not deployment or independent-review evidence.
`TASQ_CLOUD_DATABASE_MODE` makes the runtime binding explicit. During a live
migration, `TASQ_CLOUD_MAINTENANCE=true` keeps health reporting available and
rejects every other route before it can read or mutate control state.

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
