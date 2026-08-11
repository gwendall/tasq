# Fly private beta

This profile is the first hosted Tasq Server deployment, not the final
multi-tenant Managed Cloud architecture. It deliberately reuses the current
SQLite mono-writer Server on one Fly Machine and one encrypted Fly Volume in
Paris. It does not add a provider dependency to Core or the Cloud control-plane
interfaces.

## Public topology

| URL | Owner | Purpose |
|---|---|---|
| `https://tasq.run` | Vercel | Static product and documentation site |
| `https://cloud.tasq.run` | Vercel | Human entrypoint; temporary redirect to the hosted Console |
| `https://api.tasq.run` | Fly app `tasq-api` | Canonical Server origin, REST, remote MCP and `/console` |

`api.tasq.run` is the only Server origin and therefore the only JWT audience
and enrollment issuer. `cloud.tasq.run` must redirect; it must never proxy the
Console under a second browser origin.

## Provisioned substrate

The maintainer account owns:

- Fly app `tasq-api` in organization `personal`;
- encrypted volume `tasq_data`, 1 GiB, region `cdg`;
- scheduled volume snapshots retained for 30 days;
- shared IPv4 and dedicated public IPv6 ingress;
- Fly certificate request for `api.tasq.run`;
- an app-scoped deploy token stored only in GitHub environment `beta` as
  `FLY_API_TOKEN`;
- registrar DNS records for `api` and `cloud` that preserve the existing apex
  and `www` records.

The volume is intentionally single-writer. Do not scale this process above one
Machine, clone the volume as a live replica or select rolling/blue-green
deployment. Fly snapshots are a recovery layer, not the TQ-807 application
backup.

## Secrets

The Fly app must contain exactly these runtime secret names before deployment:

- `TASQ_SERVER_CONFIG_B64`: base64 of the complete
  `tasq.server-config.v1` JSON; Fly decodes it into
  `/etc/tasq/server.json` through `[[files]]`;
- `TASQ_SERVER_BOOTSTRAP_B64`: base64 of the deterministic initial
  `tasq.server-bootstrap.v1` manifest, used only when the workflow is invoked
  with `initialize=true`;
- `TASQ_SERVER_ENROLLMENT_PEPPER`: canonical 32-byte base64url secret.

The config uses `https://api.tasq.run/` for `publicUrl`, primary and additional
JWT audiences, and `enrollment.issuer`. Database URLs stay under
`file:/var/lib/tasq/`. Never put a private signing key in the Server config.
The protected workflow checks secret names and Fly topology without reading
secret values.

## Volume ownership

The Server image fixes the `tasq` runtime UID/GID at `10001:10001`. Fly init
mounts the volume for the image's configured user; a real unprivileged-image
probe on the provisioned volume observed the mount owner follow that image UID.
The fixed Server identity therefore prevents an allocator-dependent UID from
changing across releases. The deploy workflow also refuses a missing,
duplicate, unencrypted or wrong-region volume, and readiness proves the Server
can open every database after mount.

## Deploy

The only deployment path is
`.github/workflows/deploy-fly-private-beta.yml`. Supply the exact published
Server digest, its source commit and the confirmation string. On the first run,
set `initialize=true`; bootstrap is deterministic and safe to retry only with
the exact same manifest.

The workflow:

1. verifies the protected GitHub attestation for the exact GHCR digest;
2. checks the app, volume, secret names and certificate;
3. deploys one Machine with `--image` and `--ha=false`;
4. optionally runs the deterministic bootstrap inside that Machine;
5. proves `/healthz`, `/readyz`, `/version` and `/console` over the canonical
   hostname;
6. uploads a redacted deployment report.

The current hard gate is the absent protected `v0.4.0` Server image. A local
build, mutable tag or Fly-registry rebuild is not a substitute.

## Backup and rollback

Before every upgrade, run the image's native `backup` command into a timestamped
directory on the mounted volume, verify `manifest.json` and `.complete`, then
copy the completed directory off Fly. The private beta is not durable enough
for a reliability claim until an off-site Tigris upload and a create-only
restore drill have both passed.

Rollback means: stop the Machine, create a fresh volume, restore a verified
application backup into absent database paths with the exact matching config,
run `check`, then switch the deployment. Never overwrite live SQLite/WAL files.

## Current non-claims

- This is not TQ-901 multi-tenant Managed Cloud.
- It has no provider autoscaling or multi-region failover.
- Volume snapshots do not satisfy the off-site backup gate.
- Remote effects remain disabled.
- The endpoint is not live until the protected Server image is published and
  the workflow's HTTP proof passes.
