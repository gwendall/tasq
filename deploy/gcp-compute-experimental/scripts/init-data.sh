#!/bin/bash
set -euo pipefail

readonly RUNTIME_ROOT="/var/lib/tasq-runtime"
readonly CADDY_RUNTIME_ID="65532:65532"
# shellcheck source=/dev/null
source "${RUNTIME_ROOT}/deployment.env"

if [[ ! "${TASQ_SERVER_IMAGE}" =~ ^ghcr\.io/gwendall/tasq-server@sha256:[0-9a-f]{64}$ ]]; then
  echo "Tasq Server image lost exact GHCR digest authority" >&2
  exit 1
fi
if [[ ! "${CADDY_IMAGE}" =~ ^caddy:[^@[:space:]]+@sha256:[0-9a-f]{64}$ ]]; then
  echo "Caddy image lost exact digest authority" >&2
  exit 1
fi

# Resolve ownership from the exact runtime images rather than assuming host or
# image UIDs. These init containers have no network, a read-only root, a
# bounded writable mount and only the capabilities required to traverse and
# change ownership. Normal Server and Caddy containers still run as their
# image-defined non-root users.
docker run --rm \
  --user root \
  --network none \
  --read-only \
  --cap-drop ALL \
  --cap-add CHOWN \
  --cap-add DAC_OVERRIDE \
  --security-opt no-new-privileges:true \
  --volume "${DATA_ROOT}/live:/var/lib/tasq" \
  --volume "${DATA_ROOT}/backups:/backups" \
  --volume "${DATA_ROOT}/recovery:/recovery" \
  --volume "${RUNTIME_ROOT}/server.json:/etc/tasq/server.json" \
  --volume "${RUNTIME_ROOT}/bootstrap.json:/etc/tasq/bootstrap.json" \
  --entrypoint sh \
  "${TASQ_SERVER_IMAGE}" \
  -eu -c 'owner="$(id -u tasq):$(id -g tasq)"; chown -R "${owner}" /var/lib/tasq /backups /recovery /etc/tasq/server.json /etc/tasq/bootstrap.json'

docker run --rm \
  --user root \
  --network none \
  --read-only \
  --cap-drop ALL \
  --cap-add CHOWN \
  --cap-add DAC_OVERRIDE \
  --security-opt no-new-privileges:true \
  --volume "${DATA_ROOT}/caddy-data:/data" \
  --volume "${DATA_ROOT}/caddy-config:/config" \
  --entrypoint sh \
  "${CADDY_IMAGE}" \
  -eu -c "chown -R ${CADDY_RUNTIME_ID} /data /config"
