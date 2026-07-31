#!/bin/bash
set -euo pipefail

readonly RUNTIME_ROOT="/var/lib/tasq-runtime"
# shellcheck source=/dev/null
source "${RUNTIME_ROOT}/deployment.env"

BACKUP_ID="${1:-}"
if [[ ! "${BACKUP_ID}" =~ ^[0-9]{8}T[0-9]{6}Z-[a-z0-9][a-z0-9-]{0,31}$ ]]; then
  echo "usage: backup.sh <explicit-utc-id, e.g. 20260731T120000Z-manual>" >&2
  exit 2
fi

BACKUP_PATH="${DATA_ROOT}/backups/${BACKUP_ID}"
if [[ -e "${BACKUP_PATH}" ]]; then
  echo "backup destination already exists: ${BACKUP_ID}" >&2
  exit 1
fi

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
  --volume "${DATA_ROOT}/backups:/backups" \
  "${TASQ_SERVER_IMAGE}" \
  backup \
  --config /etc/tasq/server.json \
  --output "/backups/${BACKUP_ID}"

if [[ ! -f "${BACKUP_PATH}/manifest.json" || ! -f "${BACKUP_PATH}/.complete" || -e "${BACKUP_PATH}/.incomplete" ]]; then
  echo "Tasq backup did not produce a complete manifest" >&2
  exit 1
fi

docker run --rm \
  --network host \
  --volume "${DATA_ROOT}/backups:/backups:ro" \
  --entrypoint gcloud \
  "${SECRET_FETCHER_IMAGE}" \
  storage cp \
  --quiet \
  --recursive \
  "/backups/${BACKUP_ID}" \
  "gs://${BACKUP_BUCKET}/"

echo "uploaded complete Tasq backup gs://${BACKUP_BUCKET}/${BACKUP_ID}"
