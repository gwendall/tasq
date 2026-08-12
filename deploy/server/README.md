# Self-host Tasq Server

This directory is the supported TQ-807 reference deployment. It runs one Tasq
Server behind Caddy-managed HTTPS. The Server image contains no provider
connector and remote effects are disabled.

## Prerequisites

- a Linux host with Docker Engine and Docker Compose;
- a DNS name pointing at that host, with ports 80 and 443 reachable;
- an OpenID Connect or OAuth issuer that can issue RS256 access JWTs with an
  `at+jwt` header, stable `sub`, exact Tasq audience and configured scopes;
- the issuer's current public RSA JWK and your own subject identifier.

Tasq can also issue one-use enrollment tokens for agents after the authority
store has been bootstrapped. Actor labels are never credentials.

## 1. Configure

```bash
cd deploy/server
cp .env.example .env
cp server.example.json server.json
cp bootstrap.example.json bootstrap.json
openssl rand -base64 32 | tr '+/' '-_' | tr -d '='
```

Put the generated secret in `.env` as
`TASQ_SERVER_ENROLLMENT_PEPPER`. Back it up in a password manager: changing it
invalidates opaque enrollment/access tokens. It is never stored in JSON or the
database.

Edit:

- `TASQ_DOMAIN` in `.env`;
- every `tasks.example.com` URL in `server.json`;
- the JWT issuer, JWK `kid`, `n` and `e`;
- the workspace and opaque storage binding;
- the same tenant/workspace plus your issuer and `sub` in `bootstrap.json`.

`server.json` accepts built-in JWT scope profiles:

- `reader`: workspace and commitment reads;
- `coordinator`: reads plus commitment, claim, attempt, evidence and generic
  resource coordination.

Both are only token upper bounds. The live subject binding and Server grant
must also allow every request.

Up to seven additional independent issuers can be declared in
`additionalJwtIssuers`. Each has its own keys, audience, clock skew and scope
map; issuer strings must be unique. The daemon verifies a bounded list and the
authority store still requires an exact issuer/subject binding in the selected
workspace.

Validate and initialize the authority/domain stores:

```bash
docker compose build tasq
docker compose run --rm tasq bootstrap \
  --config /etc/tasq/server.json \
  --bootstrap /etc/tasq/bootstrap.json
docker compose run --rm tasq check --config /etc/tasq/server.json
```

Bootstrap is deterministic and safe to retry with the exact same files. Do not
edit `createdAt`, reorder identities or reuse a partially applied bootstrap
manifest for a different topology.

## 2. Start

```bash
docker compose up -d
curl --fail "https://${TASQ_DOMAIN}/healthz"
curl --fail "https://${TASQ_DOMAIN}/readyz"
curl --fail "https://${TASQ_DOMAIN}/version"
```

The daemon binds publicly only when `trustTlsProxy` is explicitly true, while
all externally visible URLs remain the configured HTTPS origin. Caddy
terminates TLS. `/healthz`, `/readyz`, `/version`, `/support` and bounded
workspace-free `/metrics` contain no ledger data. All REST, MCP and Console
state crosses the same live authority guard.

An authenticated redacted bundle is available at
`/v1/workspaces/<percent-encoded-id>/support-bundle`. It contains no tokens,
claims, database paths, commitment content or event payloads.

## 3. Enroll an agent or device

The principal and its `oauth_introspection` subject must already exist in
`bootstrap.json`.

```bash
docker compose run --rm tasq enroll \
  --config /etc/tasq/server.json \
  --workspace team/main \
  --principal agent \
  --subject agent-subject \
  --client-kind workload_agent
```

Copy the one-use token from stdout to the target machine, then:

```bash
export TASQ_ENROLLMENT_TOKEN='tasq_enroll_…'
tasq remote enroll \
  --endpoint "https://${TASQ_DOMAIN}/" \
  --workspace team/main \
  --profile work
tasq remote list --profile work
tasq remote operations --profile work
```

The local profile is private and deleting it does not delete Server data.
Revoke a compromised opaque credential by its credential ID:

```bash
docker compose run --rm tasq revoke-credential \
  --config /etc/tasq/server.json \
  --workspace team/main \
  --credential credential-id \
  --expected-revision 1
```

Revocation is enforced on the next request.

## Hosted Console

Open `https://$TASQ_DOMAIN/console`. Paste a workspace ID and scoped access
token. The token is posted over HTTPS, checked by the same REST guard and
exchanged for a `Secure; HttpOnly; SameSite=Strict` cookie. The Console is
not a second mutation service and does not use Local Console's loopback trust
model. Its bounded TQ-811 forms support commitment creation, claim acquisition,
blocking with an expected revision, evidence append, explicit unverified
evidence-trust attribution, completion proposal and independent completion
attestation. Every form re-enters the registered REST operation and the same
live authority guard; there is no direct Console-to-Core write path.

## Backup and restore

Online backup uses SQLite `VACUUM INTO` for the authority store, each workspace
ledger and each mutation-receipt store, then writes a checksummed immutable
manifest:

```bash
docker compose run --rm -v "$PWD/backups:/backups" tasq backup \
  --config /etc/tasq/server.json \
  --output "/backups/$(date -u +%Y%m%dT%H%M%SZ)"
```

Copy the completed directory off-host. A valid backup has `manifest.json` and
`.complete` and no `.incomplete`.

Restore is deliberately create-only. Stop the Server and restore into absent
database paths using the exact matching config:

```bash
docker compose down
docker compose run --rm -v "$PWD/backups:/backups:ro" tasq restore \
  --config /etc/tasq/server.json \
  --input /backups/20260724T120000Z
docker compose run --rm tasq check --config /etc/tasq/server.json
docker compose up -d
```

Restore refuses an existing destination, topology/config mismatch or any
checksum mismatch. For rollback, restore a matching pre-upgrade backup into a
fresh volume and switch the deployment only after `check` succeeds. Never
copy live WAL files or overwrite a running database.

## Upgrade

1. Take and move a completed backup off-host.
2. Pin the new image digest, not a mutable tag.
3. Run `check` against a staging copy restored from that backup.
4. Stop the old daemon, start the new image and verify readiness/version.
5. Run one read plus an idempotent mutation retry.

Authority, Core and receipt migrations are checksum-verified at startup. A
binary that cannot open every configured binding never reaches readiness.

## Security boundaries

- Keep `.env`, tokens, private keys and data volumes out of git.
- The image consumes public JWKs only; private signing keys remain with the
  identity provider.
- Do not expose port 8787 directly. HTTPS at the configured origin is part of
  the credential audience contract.
- Provider connectors, SMTP/Slack/GitHub credentials and effect execution do
  not belong in this image.
- A valid token still needs a live subject binding, principal and grant.
- Support bundles and multi-tenant managed operations are later milestones,
  not claims of this self-hosted artifact.

Run the repository container proof with:

```bash
docker build -f deploy/server/Dockerfile -t tasq-server:tq807 .
bun scripts/server-container-smoke.ts tasq-server:tq807
```

## Protected image status

Tasq Server `0.4.0` is published for Linux amd64/arm64 with OCI SBOM and
provenance. The protected release replay certified this immutable reference:

```text
ghcr.io/gwendall/tasq-server@sha256:35ef0553dd370b6c7731152cb0fcc56775a9ddd926a1b3999c43bccc20f38452
```

Operators must pin that digest; the version tag is discovery metadata, never
deployment authority. Publication evidence is recorded in
`docs/contracts/TQ-808_SERVER_HOSTILE_CERTIFICATION.json`.
