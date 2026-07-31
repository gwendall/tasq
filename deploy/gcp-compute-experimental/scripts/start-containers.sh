#!/bin/bash
set -euo pipefail

readonly RUNTIME_ROOT="/var/lib/tasq-runtime"
# shellcheck source=/dev/null
source "${RUNTIME_ROOT}/deployment.env"

if [[ "${EFFECTS_ENABLED}" != "false" ]]; then
  echo "experimental deployment requires effects=false" >&2
  exit 1
fi
if [[ ! "${TASQ_SERVER_IMAGE}" =~ ^ghcr\.io/gwendall/tasq-server@sha256:[0-9a-f]{64}$ ]]; then
  echo "Tasq Server image lost exact GHCR digest authority" >&2
  exit 1
fi

docker pull "${TASQ_SERVER_IMAGE}"
docker pull "${CADDY_IMAGE}"
"${RUNTIME_ROOT}/init-data.sh"
docker network inspect tasq-experimental >/dev/null 2>&1 \
  || docker network create tasq-experimental >/dev/null

docker rm --force tasq-experimental-server tasq-experimental-caddy >/dev/null 2>&1 || true

docker run --rm \
  --user tasq \
  --network none \
  --env-file "${RUNTIME_ROOT}/server.env" \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --volume "${RUNTIME_ROOT}/server.json:/etc/tasq/server.json:ro" \
  --volume "${RUNTIME_ROOT}/bootstrap.json:/etc/tasq/bootstrap.json:ro" \
  --volume "${DATA_ROOT}/live:/var/lib/tasq" \
  "${TASQ_SERVER_IMAGE}" \
  bootstrap \
  --config /etc/tasq/server.json \
  --bootstrap /etc/tasq/bootstrap.json

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

docker run --detach \
  --name tasq-experimental-server \
  --restart unless-stopped \
  --user tasq \
  --network tasq-experimental \
  --env-file "${RUNTIME_ROOT}/server.env" \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --volume "${RUNTIME_ROOT}/server.json:/etc/tasq/server.json:ro" \
  --volume "${DATA_ROOT}/live:/var/lib/tasq" \
  "${TASQ_SERVER_IMAGE}" \
  serve \
  --config /etc/tasq/server.json >/dev/null

server_ready() {
  docker exec tasq-experimental-server \
    bun -e 'process.exit((await fetch("http://127.0.0.1:8787/readyz")).ok ? 0 : 1)' \
    >/dev/null 2>&1
}

for _ in $(seq 1 60); do
  if server_ready; then
    break
  fi
  sleep 1
done
if ! server_ready; then
  docker logs tasq-experimental-server >&2 || true
  exit 1
fi

{
  printf '%s {\n' "${DOMAIN}"
  printf '\tencode zstd gzip\n'
  printf '\treverse_proxy tasq-experimental-server:8787\n'
  printf '\theader {\n'
  printf '\t\tStrict-Transport-Security "max-age=31536000; includeSubDomains"\n'
  printf '\t\t-Server\n'
  printf '\t}\n'
  printf '}\n'
} > "${RUNTIME_ROOT}/Caddyfile.tmp"
chmod 0644 "${RUNTIME_ROOT}/Caddyfile.tmp"
mv "${RUNTIME_ROOT}/Caddyfile.tmp" "${RUNTIME_ROOT}/Caddyfile"

docker run --detach \
  --name tasq-experimental-caddy \
  --restart unless-stopped \
  --user 65532:65532 \
  --network tasq-experimental \
  --publish 80:80 \
  --publish 443:443 \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=32m \
  --cap-drop ALL \
  --cap-add NET_BIND_SERVICE \
  --security-opt no-new-privileges:true \
  --volume "${RUNTIME_ROOT}/Caddyfile:/etc/caddy/Caddyfile:ro" \
  --volume "${DATA_ROOT}/caddy-data:/data" \
  --volume "${DATA_ROOT}/caddy-config:/config" \
  "${CADDY_IMAGE}" >/dev/null

echo "Tasq experimental runtime started from ${TASQ_SERVER_IMAGE}"
