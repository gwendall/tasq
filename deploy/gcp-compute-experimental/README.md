# Experimental Tasq Server on Google Compute Engine

This is the shortest deployable hosted experiment compatible with Tasq
Server's current SQLite mono-writer boundary. It provisions one
Container-Optimized OS VM in `europe-west9`, one zonal persistent data disk, a
regional off-VM backup bucket, Secret Manager access and Caddy-managed HTTPS.

It is explicitly **experimental self-hosting infrastructure**. It is not the
TQ-901–TQ-905 managed Cloud, not highly available, not multi-region and not a
production support claim. Effects remain disabled. A zone, VM or operator
failure can cause downtime; recovery is from the persistent disk or the latest
completed application backup.

No resources were created while adding this profile. The local `gcloud`
installation had no active identity, and the exact project, billing account,
domain, Server digest and helper-image digest were unavailable.

## Fixed decisions

- Location: `europe-west9`, with a single VM and `pd-balanced` data disk in one
  Paris zone.
- Runtime: the protected `ghcr.io/gwendall/tasq-server` image by exact digest.
  A tag, `latest` or a locally built image is not deployment authority.
- Edge: Caddy by exact verified multi-platform digest; only ports 80 and 443
  are public. Port 8787 stays on the private Docker network.
- Administration: OS Login over IAP TCP forwarding only. There is no
  Internet-wide SSH rule.
- Secrets: existing Secret Manager resources, each read at an explicit numeric
  version. Secret payloads never enter Terraform inputs, metadata or state.
- Backups: native, checksummed Tasq backups copied to a versioned regional
  Cloud Storage bucket with 35-day retention and soft-delete protection.
- Safety: VM deletion protection and Terraform `prevent_destroy` on the data
  disk and backup bucket.

## Architecture and limitations

```text
Internet -> static IPv4 -> Caddy :443 -> private Docker network -> Tasq :8787
                                      |
                                      +-> zonal persistent disk (SQLite)
                                                |
                                                +-> native backup
                                                       |
                                                       +-> regional GCS bucket
```

There is one live writer, one zone and no automated failover. This deliberately
preserves Server's certified storage model instead of inventing a distributed
SQLite topology. The operator owns DNS, identity-provider configuration,
monitoring, backup cadence, restore drills, upgrades and incident response.
Provider connectors and remote effect execution do not belong in this
deployment.

## Prerequisites

Do not apply until all of these are exact and reviewed:

1. A dedicated GCP project with active billing and a logged-in deployment
   identity. Do not reuse a stale local `gcloud` project by accident.
2. A controlled DNS hostname. Terraform intentionally does not mutate its DNS
   zone; create its `A` record only after reviewing the planned static address.
3. An authorized, protected Tasq Server image digest. The repository currently
   documents the public Server image gate as closed; a placeholder digest is
   not deployable.
4. A reviewed Google Cloud CLI helper image digest. It is used only for Secret
   Manager reads and backup object transfer.
5. Three existing Secret Manager secrets and their explicit enabled numeric
   versions: Server config JSON, deterministic bootstrap JSON and the
   enrollment pepper.
6. Terraform 1.7+ and an operator identity allowed to enable APIs and create
   the resources in this directory. Operators using IAP SSH also need the
   appropriate IAP tunnel and OS Login roles; this module intentionally does
   not grant human access.

Confirm the account and project before any mutation:

```bash
gcloud auth list
gcloud config get-value project
gcloud projects describe EXACT_PROJECT_ID
gcloud beta billing projects describe EXACT_PROJECT_ID
```

## Prepare secret payloads

Start from `deploy/server/server.example.json` and
`deploy/server/bootstrap.example.json`. In the Server config:

- set `publicUrl`, JWT audience and enrollment issuer to
  `https://YOUR_DOMAIN/`;
- bind `0.0.0.0:8787` with `trustTlsProxy: true`;
- keep all SQLite URLs under `/var/lib/tasq`, which is the persistent-disk
  mount inside the container;
- configure only reviewed RS256 public keys, issuers, subjects, scopes and
  workspaces.

Keep the exact bootstrap file immutable after first use. Generate a base64url
pepper with at least 32 characters and keep a separate recovery copy in an
operator-controlled password manager.

Creating secrets and adding versions changes external state, so run commands
like these only after selecting the exact project:

```bash
gcloud secrets create tasq-experimental-server-config \
  --project EXACT_PROJECT_ID --replication-policy automatic
gcloud secrets versions add tasq-experimental-server-config \
  --project EXACT_PROJECT_ID --data-file /secure/path/server.json

gcloud secrets create tasq-experimental-bootstrap \
  --project EXACT_PROJECT_ID --replication-policy automatic
gcloud secrets versions add tasq-experimental-bootstrap \
  --project EXACT_PROJECT_ID --data-file /secure/path/bootstrap.json

gcloud secrets create tasq-experimental-enrollment-pepper \
  --project EXACT_PROJECT_ID --replication-policy automatic
gcloud secrets versions add tasq-experimental-enrollment-pepper \
  --project EXACT_PROJECT_ID --data-file /secure/path/enrollment-pepper
```

Record the returned numeric versions. Never put payloads in
`terraform.tfvars`, shell history or instance metadata.

## Plan and apply

```bash
cd deploy/gcp-compute-experimental
cp terraform.tfvars.example terraform.tfvars
# Replace every placeholder with an exact reviewed value.
terraform fmt -check -recursive
terraform init
terraform validate
terraform plan -out tasq-experimental.tfplan
terraform show tasq-experimental.tfplan
```

Review the project, zone, IP, VM service account grants, exact image digests,
secret IDs and versions, firewall rules, deletion protections and bucket
before applying the saved plan:

```bash
terraform apply tasq-experimental.tfplan
terraform output public_ipv4
```

Create the hostname's `A` record with that static IPv4. Caddy obtains and
renews TLS only after public DNS resolves and ports 80/443 reach the VM.

The startup script formats only an unformatted disk, mounts it at
`/mnt/disks/tasq`, fetches the pinned secret versions, idempotently bootstraps
and checks Server, waits for readiness using Bun from the exact Server image,
then starts Caddy. Bounded networkless init containers resolve `tasq` and
its UID from the exact Server image and assign Caddy's data to the profile's
fixed unprivileged `65532:65532` runtime identity; normal containers remain
non-root. A startup failure fails closed instead of exposing port 8787.

## Verify and operate

```bash
curl --fail https://YOUR_DOMAIN/healthz
curl --fail https://YOUR_DOMAIN/readyz
curl --fail https://YOUR_DOMAIN/version
curl --fail https://YOUR_DOMAIN/support

gcloud compute ssh tasq-experimental \
  --project EXACT_PROJECT_ID \
  --zone europe-west9-a \
  --tunnel-through-iap
```

On the VM:

```bash
sudo docker ps
sudo docker logs tasq-experimental-server
sudo docker logs tasq-experimental-caddy
sudo /var/lib/tasq-runtime/start-containers.sh
```

Do not paste access tokens into logs or support transcripts.

## Backup and restore

The backup script requires an operator-supplied UTC identifier; it never
manufactures evidence time from the device clock:

```bash
sudo /var/lib/tasq-runtime/backup.sh 20260731T120000Z-manual
```

Schedule it from an operator-controlled system with an explicit ID and alert
on non-zero exit. The script accepts only a native backup with
`manifest.json`, `.complete` and no `.incomplete`, then uploads it off-VM.
Define the acceptable RPO and test a restore before putting valuable data into
the experiment.

Restore is intentionally explicit and create-only:

```bash
sudo /var/lib/tasq-runtime/restore.sh \
  20260731T120000Z-manual \
  RESTORE_EXPERIMENTAL_TASQ
```

It downloads the selected backup, verifies completion, stops the containers,
moves the previous live directory aside, restores into an empty live
directory, runs `check`, and restarts. On failure it restores the previous live
directory and attempts to restart it. Previous and failed bytes are retained
for manual recovery; the script does not erase them.

## Upgrade

1. Take a completed off-VM backup and verify that it is present in the bucket.
2. Resolve and independently review the new Server multi-platform digest.
3. Change only `tasq_server_image`, then run and review a saved Terraform plan.
4. Apply. The changed metadata restarts the VM; startup pulls the exact digest,
   retries the immutable bootstrap, runs `check`, and reaches readiness before
   Caddy starts.
5. Verify health, version, one authorized read and an idempotent mutation
   retry. Roll back by restoring the old digest and, if required by a storage
   migration, an exact matching pre-upgrade application backup.

Changing a secret payload alone has no effect because versions are pinned.
Change the corresponding version variable and review the plan.

## Teardown

Teardown is not a normal operation. VM deletion protection and Terraform
`prevent_destroy` deliberately stop a broad `terraform destroy`. If the
experiment must be retired, first take and independently verify a final
backup, revoke credentials, preserve required audit material, and review each
resource's retention obligation. Disable protections only in a separately
reviewed change and delete exact resources one by one. Never use broad
recursive deletion or `force_destroy` for the backup bucket.
