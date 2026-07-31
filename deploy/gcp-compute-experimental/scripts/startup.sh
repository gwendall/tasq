#!/bin/bash
set -euo pipefail

readonly METADATA_ROOT="http://metadata.google.internal/computeMetadata/v1/instance/attributes"
readonly METADATA_HEADER="Metadata-Flavor: Google"
readonly DATA_DEVICE="/dev/disk/by-id/google-tasq-data"
readonly DATA_ROOT="/mnt/disks/tasq"
readonly RUNTIME_ROOT="/var/lib/tasq-runtime"

metadata() {
  curl --fail --silent --show-error \
    --header "${METADATA_HEADER}" \
    "${METADATA_ROOT}/$1"
}

require_match() {
  local value="$1"
  local pattern="$2"
  local label="$3"
  if [[ ! "${value}" =~ ${pattern} ]]; then
    echo "invalid ${label}" >&2
    exit 1
  fi
}

shell_assignment() {
  local name="$1"
  local value="$2"
  printf '%s=%q\n' "${name}" "${value}"
}

install_metadata_script() {
  local attribute="$1"
  local destination="$2"
  local temporary="${destination}.tmp"
  metadata "${attribute}" > "${temporary}"
  chmod 0750 "${temporary}"
  mv "${temporary}" "${destination}"
}

fetch_secret() {
  local secret_id="$1"
  local secret_version="$2"
  local output_name="$3"
  local temporary="${RUNTIME_ROOT}/${output_name}.tmp"
  docker run --rm \
    --network host \
    --volume "${RUNTIME_ROOT}:/out" \
    --entrypoint gcloud \
    "${SECRET_FETCHER_IMAGE}" \
    secrets versions access "${secret_version}" \
    --quiet \
    --project "${PROJECT_ID}" \
    --secret "${secret_id}" \
    --out-file "/out/${output_name}.tmp"
  chmod 0600 "${temporary}"
  mv "${temporary}" "${RUNTIME_ROOT}/${output_name}"
}

PROJECT_ID="$(metadata tasq-project-id)"
DOMAIN="$(metadata tasq-domain)"
TASQ_SERVER_IMAGE="$(metadata tasq-server-image)"
CADDY_IMAGE="$(metadata tasq-caddy-image)"
SECRET_FETCHER_IMAGE="$(metadata tasq-secret-fetcher-image)"
SERVER_CONFIG_SECRET_ID="$(metadata tasq-server-config-secret)"
SERVER_CONFIG_SECRET_VERSION="$(metadata tasq-server-config-secret-version)"
BOOTSTRAP_SECRET_ID="$(metadata tasq-bootstrap-secret)"
BOOTSTRAP_SECRET_VERSION="$(metadata tasq-bootstrap-secret-version)"
ENROLLMENT_PEPPER_SECRET_ID="$(metadata tasq-enrollment-pepper-secret)"
ENROLLMENT_PEPPER_SECRET_VERSION="$(metadata tasq-enrollment-pepper-secret-version)"
BACKUP_BUCKET="$(metadata tasq-backup-bucket)"
EFFECTS_ENABLED="$(metadata tasq-experimental-effects)"

require_match "${PROJECT_ID}" '^[a-z][a-z0-9-]{4,28}[a-z0-9]$' "project ID"
require_match "${DOMAIN}" '^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$' "domain"
require_match "${TASQ_SERVER_IMAGE}" '^ghcr\.io/gwendall/tasq-server@sha256:[0-9a-f]{64}$' "Tasq Server image authority"
require_match "${CADDY_IMAGE}" '^caddy:[^@[:space:]]+@sha256:[0-9a-f]{64}$' "Caddy image"
require_match "${SECRET_FETCHER_IMAGE}" '^([^/[:space:]]+/)+[^@[:space:]]+:[^@[:space:]]+@sha256:[0-9a-f]{64}$' "secret fetcher image"
require_match "${SERVER_CONFIG_SECRET_ID}" '^[A-Za-z0-9_-]{1,255}$' "Server config secret ID"
require_match "${SERVER_CONFIG_SECRET_VERSION}" '^[1-9][0-9]*$' "Server config secret version"
require_match "${BOOTSTRAP_SECRET_ID}" '^[A-Za-z0-9_-]{1,255}$' "bootstrap secret ID"
require_match "${BOOTSTRAP_SECRET_VERSION}" '^[1-9][0-9]*$' "bootstrap secret version"
require_match "${ENROLLMENT_PEPPER_SECRET_ID}" '^[A-Za-z0-9_-]{1,255}$' "enrollment pepper secret ID"
require_match "${ENROLLMENT_PEPPER_SECRET_VERSION}" '^[1-9][0-9]*$' "enrollment pepper secret version"
require_match "${BACKUP_BUCKET}" '^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$' "backup bucket"

if [[ "${EFFECTS_ENABLED}" != "false" ]]; then
  echo "experimental deployment requires effects=false" >&2
  exit 1
fi

for _ in $(seq 1 60); do
  [[ -b "${DATA_DEVICE}" ]] && break
  sleep 1
done
if [[ ! -b "${DATA_DEVICE}" ]]; then
  echo "persistent data disk did not appear" >&2
  exit 1
fi

if ! blkid "${DATA_DEVICE}" >/dev/null 2>&1; then
  mkfs.ext4 -F -m 0 "${DATA_DEVICE}"
fi

mkdir -p "${DATA_ROOT}" "${RUNTIME_ROOT}"
if ! mountpoint -q "${DATA_ROOT}"; then
  mount -o discard,defaults "${DATA_DEVICE}" "${DATA_ROOT}"
fi
mkdir -p \
  "${DATA_ROOT}/live" \
  "${DATA_ROOT}/backups" \
  "${DATA_ROOT}/recovery" \
  "${DATA_ROOT}/caddy-data" \
  "${DATA_ROOT}/caddy-config"
chmod 0700 "${DATA_ROOT}/live" "${DATA_ROOT}/backups" "${DATA_ROOT}/recovery"

install_metadata_script tasq-start-script "${RUNTIME_ROOT}/start-containers.sh"
install_metadata_script tasq-init-script "${RUNTIME_ROOT}/init-data.sh"
install_metadata_script tasq-backup-script "${RUNTIME_ROOT}/backup.sh"
install_metadata_script tasq-restore-script "${RUNTIME_ROOT}/restore.sh"

{
  shell_assignment PROJECT_ID "${PROJECT_ID}"
  shell_assignment DOMAIN "${DOMAIN}"
  shell_assignment TASQ_SERVER_IMAGE "${TASQ_SERVER_IMAGE}"
  shell_assignment CADDY_IMAGE "${CADDY_IMAGE}"
  shell_assignment SECRET_FETCHER_IMAGE "${SECRET_FETCHER_IMAGE}"
  shell_assignment BACKUP_BUCKET "${BACKUP_BUCKET}"
  shell_assignment DATA_ROOT "${DATA_ROOT}"
  shell_assignment RUNTIME_ROOT "${RUNTIME_ROOT}"
  shell_assignment EFFECTS_ENABLED "${EFFECTS_ENABLED}"
} > "${RUNTIME_ROOT}/deployment.env.tmp"
chmod 0600 "${RUNTIME_ROOT}/deployment.env.tmp"
mv "${RUNTIME_ROOT}/deployment.env.tmp" "${RUNTIME_ROOT}/deployment.env"

docker pull "${SECRET_FETCHER_IMAGE}"
fetch_secret "${SERVER_CONFIG_SECRET_ID}" "${SERVER_CONFIG_SECRET_VERSION}" server.json
fetch_secret "${BOOTSTRAP_SECRET_ID}" "${BOOTSTRAP_SECRET_VERSION}" bootstrap.json
fetch_secret "${ENROLLMENT_PEPPER_SECRET_ID}" "${ENROLLMENT_PEPPER_SECRET_VERSION}" enrollment-pepper

PEPPER="$(tr -d '\r\n' < "${RUNTIME_ROOT}/enrollment-pepper")"
require_match "${PEPPER}" '^[A-Za-z0-9_-]{32,2000}$' "enrollment pepper"
printf 'TASQ_SERVER_ENROLLMENT_PEPPER=%s\n' "${PEPPER}" > "${RUNTIME_ROOT}/server.env.tmp"
chmod 0600 "${RUNTIME_ROOT}/server.env.tmp"
mv "${RUNTIME_ROOT}/server.env.tmp" "${RUNTIME_ROOT}/server.env"
unset PEPPER
rm -f "${RUNTIME_ROOT}/enrollment-pepper"

"${RUNTIME_ROOT}/start-containers.sh"
