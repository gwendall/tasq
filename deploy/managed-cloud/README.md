# Managed Cloud experimental deployment

This profile runs the private TQ-901–TQ-905 source candidate on Fly. It is not
an available managed service. Remote effects stay disabled and the current
reference identity provider is not a production identity provider.

The control runtime accepts either its historical local SQLite database or a
remote libSQL database:

- `TASQ_CLOUD_DATABASE_MODE` is exactly `local` or `managed` and defaults to
  `local`;
- `TASQ_CLOUD_DATABASE_URL` is a credential-free `libsql://` or `https://`
  URL;
- `TASQ_CLOUD_DATABASE_AUTH_TOKEN` contains the separate bearer credential;
- when both are absent, the runtime continues to use
  `/data/control.sqlite` on the attached Fly volume.

The protected workflow exposes the same explicit database mode and requires
both secrets for `managed`. Local mode rejects remote database secrets instead
of silently ignoring them. Their presence proves only that a binding exists.
It does not prove the provider, database contents, isolation or production
readiness.

## Create-only database migration

Do not remove or overwrite the current Fly volume. First deploy the candidate
once through `Deploy Fly private beta` with `control_database_mode=local`.
That installs the snapshot tool while retaining the existing volume binding.

Next close the late-write window before taking the final snapshot:

```bash
flyctl secrets set --app tasq-control TASQ_CLOUD_MAINTENANCE=true
curl --fail https://control.tasq.run/healthz |
  jq --exit-status '.status == "ok" and .maintenance == true'
test "$(curl --silent --output maintenance.json --write-out '%{http_code}' \
  https://control.tasq.run/readyz)" = 503
jq --exit-status \
  '.code == "database_migration_in_progress"' maintenance.json
```

Maintenance mode leaves `/healthz` available but returns `503` before every
other route, including login, callback, BFF, readiness and administrative
mutations. Existing control-plane bytes therefore remain readable over SSH
but cannot change through the public runtime. Keep maintenance enabled until
the managed deployment succeeds.

Choose and record an explicit RFC 3339 observation instant and a stable
migration identifier. Run the online snapshot tool inside the maintained
`tasq-control` Machine:

```bash
flyctl ssh console --app tasq-control --command \
  'bun src/database-snapshot.ts /data/control-migration-EXACT_ID.sqlite EXACT_RFC3339 urn:tasq-provider:fly:tasq-control:volume'

flyctl ssh sftp get \
  /data/control-migration-EXACT_ID.sqlite \
  ./control-migration-EXACT_ID.sqlite \
  --app tasq-control
```

The snapshot is WAL-safe, create-only and mode `0600`. Its secret-free receipt
contains the file digest plus deterministic schema and row-content digests for
every `cloud_*` table. Preserve the receipt and downloaded snapshot in the
deployment's protected evidence system, never in this repository.

Create the managed libSQL group and database only after reviewing the account,
plan, primary location and provider recovery guarantees. Use a location code
returned by the authenticated CLI; do not infer it from a Fly region name:

```bash
turso auth whoami
turso plan show
turso db locations
turso group create EXACT_GROUP --location EXACT_PRIMARY_LOCATION --wait
turso group config delete-protection enable EXACT_GROUP
turso db create EXACT_DATABASE \
  --group EXACT_GROUP \
  --from-file ./control-migration-EXACT_ID.sqlite \
  --wait
turso db config delete-protection enable EXACT_DATABASE
```

Turso's AWS Developer offering does not support adding another location to a
group. Its point-in-time restore window can replace the single host volume for
this experimental gate, but it is not multi-region recovery evidence. Do not
run or claim a replica-location command unless the authenticated account and
provider contract explicitly support it. The separate region-recovery gate
therefore remains open for an eligible provider profile and drill.

Generate a bounded database token and stage the URL and token directly into
Fly without printing either value or writing them into a Terraform file:

```bash
{
  printf 'TASQ_CLOUD_DATABASE_URL='
  turso db show EXACT_DATABASE --url
  printf 'TASQ_CLOUD_DATABASE_AUTH_TOKEN='
  turso db tokens create EXACT_DATABASE --expiration 30d
  printf 'TASQ_CLOUD_MAINTENANCE=false\n'
} | flyctl secrets import --app tasq-control --stage
```

Use exactly one staged import for the complete cutover secret set. A later
staged secret mutation replaces the pending Machine release instead of merging
reliably with it, so splitting these values can deploy an incomplete binding.

Before deployment, export the same values into the operator process and compare
the complete imported contents with the immutable snapshot:

```bash
TASQ_CLOUD_DATABASE_URL='<credential-free URL>' \
TASQ_CLOUD_DATABASE_AUTH_TOKEN='<token>' \
pnpm --filter @tasq-internal/cloud-control-plane verify:database -- \
  ./control-migration-EXACT_ID.sqlite \
  EXACT_RFC3339 \
  urn:tasq-provider:fly:tasq-control:volume-snapshot \
  urn:tasq-provider:libsql:tasq-control
```

The command fails closed on any schema, row, value or table drift and emits no
credential. Preserve its receipt as protected evidence. Only after it passes,
run the protected workflow with `control_database_mode=managed`. The workflow
records the selected mode and refuses managed deployment if either database
secret is absent.

## Cutover and rollback

Deploy only through the protected `Deploy Fly private beta` workflow with the
exact source commit and certified Server digest. After deployment:

1. run `/healthz` and the idempotent `/admin/bootstrap` path;
2. compare the tenant/workspace and audit projections with the pre-cutover
   receipt;
3. rerun the Chromium, Firefox and WebKit browser certification;
4. record the exact control image, database provider reference and evidence
   digests in the protected readiness manifest;
5. keep the old volume and migration snapshot untouched through the complete
   rollback and observation window.

Rollback first re-enables maintenance, applies removal of both remote secrets,
then clears maintenance and runs the protected workflow with
`control_database_mode=local` and the last known-good source/image coordinates:

```bash
flyctl secrets set --app tasq-control TASQ_CLOUD_MAINTENANCE=true
flyctl secrets unset --app tasq-control \
  TASQ_CLOUD_DATABASE_URL TASQ_CLOUD_DATABASE_AUTH_TOKEN
flyctl secrets set --app tasq-control TASQ_CLOUD_MAINTENANCE=false
```

The managed-mode process is expected to stay fail-closed after the remote
credentials are removed and before the local-mode deployment completes. Do
not split the removals and maintenance change across staged releases: a later
staged mutation can replace the pending removal. The preserved volume and
snapshot remain the rollback authority throughout this bounded outage.

This returns the runtime to the preserved local volume. Never delete the
remote database, local volume or migration snapshot as part of rollback.
Destructive retirement is a later, separately reviewed TQ-904 operation with
export, retention and verified deletion evidence.

This migration can close the replacement half of TQ-901 only after protected
deployment and byte-level evidence. TQ-901 still requires an independent
multi-tenant infrastructure review.
