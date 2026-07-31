#!/bin/bash
set -euo pipefail

readonly RUNTIME_ROOT="/var/lib/tasq-runtime"
readonly REQUIRED_CONFIRMATION="RESTORE_EXPERIMENTAL_TASQ"
# shellcheck source=/dev/null
source "${RUNTIME_ROOT}/deployment.env"

BACKUP_ID="${1:-}"
CONFIRMATION="${2:-}"
if [[ ! "${BACKUP_ID}" =~ ^[0-9]{8}T[0-9]{6}Z-[a-z0-9][a-z0-9-]{0,31}$ ]]; then
  echo "usage: restore.sh <explicit-backup-id> ${REQUIRED_CONFIRMATION}" >&2
  exit 2
fi
if [[ "${CONFIRMATION}" != "${REQUIRED_CONFIRMATION}" ]]; then
  echo "restore requires exact confirmation ${REQUIRED_CONFIRMATION}" >&2
  exit 2
fi

RECOVERY_ROOT="${DATA_ROOT}/recovery/${BACKUP_ID}"
DOWNLOAD_PATH="${RECOVERY_ROOT}/download"
RETIRED_PATH="${DATA_ROOT}/retired-${BACKUP_ID}"
FAILED_PATH="${DATA_ROOT}/failed-restore-${BACKUP_ID}"

for path in "${RECOVERY_ROOT}" "${RETIRED_PATH}" "${FAILED_PATH}"; do
  if [[ -e "${path}" ]]; then
    echo "restore path already exists: ${path}" >&2
    exit 1
  fi
done
mkdir -p "${DOWNLOAD_PATH}"

docker run --rm \
  --network host \
  --volume "${RECOVERY_ROOT}:/recovery" \
  --entrypoint gcloud \
  "${SECRET_FETCHER_IMAGE}" \
  storage rsync \
  --quiet \
  --recursive \
  "gs://${BACKUP_BUCKET}/${BACKUP_ID}" \
  /recovery/download

if [[ ! -f "${DOWNLOAD_PATH}/manifest.json" || ! -f "${DOWNLOAD_PATH}/.complete" || -e "${DOWNLOAD_PATH}/.incomplete" ]]; then
  echo "remote backup is not a complete Tasq backup" >&2
  exit 1
fi

docker rm --force tasq-experimental-caddy tasq-experimental-server >/dev/null 2>&1 || true
mv "${DATA_ROOT}/live" "${RETIRED_PATH}"
mkdir -p "${DATA_ROOT}/live"
chmod 0700 "${DATA_ROOT}/live"
"${RUNTIME_ROOT}/init-data.sh"

rollback_failed_restore() {
  local exit_code=$?
  docker rm --force tasq-experimental-caddy tasq-experimental-server >/dev/null 2>&1 || true
  if [[ -d "${DATA_ROOT}/live" && -d "${RETIRED_PATH}" ]]; then
    mv "${DATA_ROOT}/live" "${FAILED_PATH}"
    mv "${RETIRED_PATH}" "${DATA_ROOT}/live"
    "${RUNTIME_ROOT}/start-containers.sh" || true
  fi
  exit "${exit_code}"
}
trap rollback_failed_restore ERR

docker run --rm \
  --user tasq \
  --network none \
  --env-file "${RUNTIME_ROOT}/server.env" \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --volume "${RUNTIME_ROOT}/server.json:/etc/tasq/server.json:ro" \
  --volume "${DATA_ROOT}/live:/var/lib/tasq" \
  --volume "${DOWNLOAD_PATH}:/backup:ro" \
  "${TASQ_SERVER_IMAGE}" \
  restore \
  --config /etc/tasq/server.json \
  --input /backup

docker run --rm \
  --user tasq \
  --network none \
  --env-file "${RUNTIME_ROOT}/server.env" \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --volume "${RUNTIME_ROOT}/server.json:/etc/tasq/server.json:ro" \
  --volume "${DATA_ROOT}/live:/var/lib/tasq" \
  "${TASQ_SERVER_IMAGE}" \
  check \
  --config /etc/tasq/server.json

"${RUNTIME_ROOT}/start-containers.sh"
trap - ERR

echo "restore passed; previous live bytes retained at ${RETIRED_PATH}"
