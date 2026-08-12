#!/usr/bin/env python3
"""Certify one exact installed Python wheel against one exact Server digest."""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import secrets
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Any

from tasq_remote import (
    TasqRemote,
    TasqRemoteError,
    __file__ as tasq_remote_file,
    __version__,
    redeem_remote_enrollment,
)

SERVER = re.compile(
    r"^ghcr\.io/gwendall/tasq-server@(sha256:[a-f0-9]{64})$"
)
VERSION = re.compile(r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$")
COMMIT = re.compile(r"^[a-f0-9]{40}$")
WORKSPACE = "certification/python"
PUBLIC_URL = "https://python-certification.tasq.invalid/"


def run(
    args: list[str], *, sensitive: bool = False, allow_failure: bool = False
) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(args, text=True, capture_output=True, check=False)
    if result.returncode and not allow_failure:
        if sensitive:
            raise RuntimeError(
                f"sensitive command failed ({result.returncode}); output redacted"
            )
        output = (result.stderr + result.stdout)[:16_384]
        raise RuntimeError(f"{args[0]} failed ({result.returncode}): {output}")
    return result


def output_json(result: subprocess.CompletedProcess[str], label: str) -> dict[str, Any]:
    try:
        value = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise RuntimeError(f"{label} returned invalid JSON") from error
    if not isinstance(value, dict):
        raise RuntimeError(f"{label} returned a non-object")
    return value


def rsa_public_jwk(root: Path) -> dict[str, str]:
    private_key = root / "unused-private.pem"
    public_key = root / "public.pem"
    run([
        "openssl",
        "genpkey",
        "-quiet",
        "-algorithm",
        "RSA",
        "-pkeyopt",
        "rsa_keygen_bits:2048",
        "-out",
        str(private_key),
    ])
    os.chmod(private_key, 0o600)
    run([
        "openssl",
        "pkey",
        "-in",
        str(private_key),
        "-pubout",
        "-out",
        str(public_key),
    ])
    modulus = run([
        "openssl",
        "rsa",
        "-pubin",
        "-in",
        str(public_key),
        "-modulus",
        "-noout",
    ]).stdout.strip()
    if not modulus.startswith("Modulus="):
        raise RuntimeError("OpenSSL returned no RSA modulus")
    modulus_bytes = bytes.fromhex(modulus.removeprefix("Modulus="))
    encoded = base64.urlsafe_b64encode(modulus_bytes).rstrip(b"=").decode("ascii")
    return {"kty": "RSA", "n": encoded, "e": "AQAB", "alg": "RS256", "use": "sig"}


def write_container_readable_json(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, separators=(",", ":")) + "\n", encoding="utf-8")
    # The released Server deliberately runs as uid 10001. These files contain
    # public configuration and bootstrap identities, not enrollment secrets.
    os.chmod(path, 0o644)


def wait_ready(endpoint: str) -> None:
    last_error: Exception | None = None
    for _ in range(100):
        try:
            with urllib.request.urlopen(endpoint + "readyz", timeout=1) as response:
                body = json.load(response)
                if response.status == 200 and body.get("status") == "ready":
                    return
        except (OSError, urllib.error.URLError, json.JSONDecodeError) as error:
            last_error = error
        time.sleep(0.1)
    raise RuntimeError("exact Server digest did not become ready") from last_error


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--source-commit", required=True)
    args = parser.parse_args()
    image_match = SERVER.fullmatch(args.image)
    if not image_match:
        parser.error("--image must be the canonical Server repository at an exact digest")
    if not VERSION.fullmatch(args.version):
        parser.error("--version must be stable SemVer")
    if not COMMIT.fullmatch(args.source_commit):
        parser.error("--source-commit must be one lowercase 40-character commit")
    if tasq_remote_file is None or not Path(tasq_remote_file).resolve().is_relative_to(
        Path(sys.prefix).resolve()
    ):
        raise RuntimeError("tasq_remote must be imported from the certification virtualenv")
    if __version__ != args.version:
        raise RuntimeError("installed wheel version does not match requested certification")

    inspection = output_json(run([
        "docker",
        "image",
        "inspect",
        args.image,
        "--format",
        "{{json .}}",
    ]), "Server image inspection")
    image_id = inspection.get("Id")
    repo_digests = inspection.get("RepoDigests")
    platform = f"{inspection.get('Os')}/{inspection.get('Architecture')}"
    labels = (inspection.get("Config") or {}).get("Labels") or {}
    required_labels = {
        "org.opencontainers.image.title": "Tasq Server",
        "org.opencontainers.image.source": "https://github.com/gwendall/tasq",
        "org.opencontainers.image.licenses": "Apache-2.0",
        "org.opencontainers.image.version": args.version,
        "org.opencontainers.image.revision": args.source_commit,
    }
    if not isinstance(image_id, str) or not re.fullmatch(r"sha256:[a-f0-9]{64}", image_id):
        raise RuntimeError("Server image has no immutable local image ID")
    if not isinstance(repo_digests, list) or args.image not in repo_digests:
        raise RuntimeError("pulled Server image does not resolve the requested digest")
    if any(labels.get(key) != value for key, value in required_labels.items()):
        raise RuntimeError("Server OCI labels do not bind the requested release identity")
    if not re.fullmatch(r"linux/(amd64|arm64)", platform):
        raise RuntimeError("Server image is not a supported Linux platform")

    suffix = uuid.uuid4().hex
    container = f"tasq-tq810-{suffix}"
    volume = f"tasq-tq810-{suffix}"
    pepper = base64.urlsafe_b64encode(secrets.token_bytes(32)).rstrip(b"=").decode()
    run(["docker", "volume", "create", volume])
    evidence: dict[str, Any] | None = None
    try:
        with tempfile.TemporaryDirectory(prefix="tasq-tq810-") as temporary:
            root = Path(temporary)
            config_path = root / "server.json"
            bootstrap_path = root / "bootstrap.json"
            write_container_readable_json(config_path, {
                "contractVersion": "tasq.server-config.v1",
                "publicUrl": PUBLIC_URL,
                "listen": {"host": "0.0.0.0", "port": 8787, "trustTlsProxy": True},
                "authorityDatabaseUrl": "file:/var/lib/tasq/authority.sqlite",
                "hostTenantId": "tq810-certification",
                "enrollment": {"issuer": PUBLIC_URL, "accessLifetimeMs": 3_600_000},
                "jwt": {
                    "issuer": "https://unused-issuer.tasq.invalid/",
                    "audience": PUBLIC_URL,
                    "keys": [{"kid": "unused-key", "jwk": rsa_public_jwk(root)}],
                    "scopeActions": {"tasq:coordinate": "coordinator"},
                    "clockSkewMs": 0,
                },
                "additionalJwtIssuers": [],
                "workspaces": [{
                    "id": WORKSPACE,
                    "storageBindingId": "tq810-python-slot",
                    "databaseUrl": "file:/var/lib/tasq/domain.sqlite",
                    "receiptDatabaseUrl": "file:/var/lib/tasq/receipts.sqlite",
                }],
                "support": {},
            })
            write_container_readable_json(bootstrap_path, {
                "contractVersion": "tasq.server-bootstrap.v1",
                "hostTenantId": "tq810-certification",
                "createdAt": 0,
                "workspaces": [{
                    "id": WORKSPACE,
                    "principals": [{
                        "id": "python-agent",
                        "kind": "agent",
                        "issuer": PUBLIC_URL,
                        "subject": "python-agent",
                        "method": "oauth_introspection",
                        "role": "coordinator",
                    }],
                }],
            })
            common = [
                "--read-only",
                "--tmpfs",
                "/tmp:rw,nosuid,nodev,noexec",
                "--cap-drop",
                "ALL",
                "--security-opt",
                "no-new-privileges",
                "--volume",
                f"{volume}:/var/lib/tasq",
                "--volume",
                f"{config_path}:/etc/tasq/server.json:ro",
                "--env",
                f"TASQ_SERVER_ENROLLMENT_PEPPER={pepper}",
            ]
            bootstrap = output_json(run([
                "docker",
                "run",
                "--rm",
                *common,
                "--volume",
                f"{bootstrap_path}:/etc/tasq/bootstrap.json:ro",
                image_id,
                "bootstrap",
                "--config",
                "/etc/tasq/server.json",
                "--bootstrap",
                "/etc/tasq/bootstrap.json",
            ]), "container bootstrap")
            if bootstrap.get("status") != "ok" or bootstrap.get("workspaces") != 1:
                raise RuntimeError("Server bootstrap did not initialize the workspace")

            enrollment = output_json(run([
                "docker",
                "run",
                "--rm",
                *common,
                image_id,
                "enroll",
                "--config",
                "/etc/tasq/server.json",
                "--workspace",
                WORKSPACE,
                "--principal",
                "python-agent",
                "--subject",
                "python-agent",
                "--client-kind",
                "workload_agent",
            ], sensitive=True), "Server enrollment")
            enrollment_token = enrollment.get("enrollmentToken")
            if not isinstance(enrollment_token, str) or not enrollment_token.startswith(
                "tasq_enroll_"
            ):
                raise RuntimeError("Server returned no one-use enrollment token")

            run([
                "docker",
                "run",
                "--detach",
                "--name",
                container,
                "--publish",
                "127.0.0.1::8787",
                *common,
                image_id,
                "serve",
                "--config",
                "/etc/tasq/server.json",
            ])
            published = run(["docker", "port", container, "8787/tcp"]).stdout.strip()
            port = re.search(r":([0-9]+)$", published)
            if not port:
                raise RuntimeError("could not resolve the loopback Server port")
            endpoint = f"http://127.0.0.1:{port.group(1)}/"
            wait_ready(endpoint)

            credential = redeem_remote_enrollment(
                endpoint=endpoint,
                workspace_id=WORKSPACE,
                enrollment_token=enrollment_token,
                request_id="tq810-enrollment",
            )
            access_token = credential.get("accessToken")
            if not isinstance(access_token, str) or not access_token.startswith(
                "tasq_access_"
            ):
                raise RuntimeError("wheel returned no access credential")
            try:
                redeem_remote_enrollment(
                    endpoint=endpoint,
                    workspace_id=WORKSPACE,
                    enrollment_token=enrollment_token,
                    request_id="tq810-enrollment-replay",
                )
                raise RuntimeError("one-use enrollment was accepted twice")
            except TasqRemoteError as error:
                if error.status != 409 or error.code != "enrollment_consumed":
                    raise

            client = TasqRemote(
                endpoint=endpoint,
                workspace_id=WORKSPACE,
                access_token=access_token,
                request_id_factory=lambda: "tq810-read",
            )
            if client.list_commitments(limit=10).get("items") != []:
                raise RuntimeError("fresh certification workspace is not empty")
            mutation = {
                "operation_id": "commitment.propose",
                "resource": {"kind": "workspace", "id": WORKSPACE},
                "input": {"title": "Exact PyPI wheel against exact Server digest"},
                "idempotency_key": "tq810-create",
                "request_id": "tq810-create-request",
            }
            created = client.execute_operation(**mutation)
            replayed = client.execute_operation(**mutation)
            if created.get("replayed") is not False or replayed.get("replayed") is not True:
                raise RuntimeError("Server did not preserve exact mutation replay semantics")
            commitment_id = created.get("resultId")
            if not isinstance(commitment_id, str):
                raise RuntimeError("mutation returned no commitment identity")
            listed = client.list_commitments(limit=10).get("items")
            if not isinstance(listed, list) or not any(
                item.get("id") == commitment_id for item in listed if isinstance(item, dict)
            ):
                raise RuntimeError("wheel could not read its committed Server mutation")

            invalid = TasqRemote(
                endpoint=endpoint,
                workspace_id=WORKSPACE,
                access_token="tasq_access_invalid".ljust(40, "x"),
                request_id_factory=lambda: "tq810-invalid-token",
            )
            try:
                invalid.list_commitments()
                raise RuntimeError("invalid credential unexpectedly read Server state")
            except TasqRemoteError as error:
                if error.status != 401 or error.code != "invalid_token" or error.retryable:
                    raise

            evidence = {
                "contractVersion": "tasq.tq810-published-wheel-server.v1",
                "status": "passed_protected_exact_artifacts",
                "python": {
                    "package": "tasq-remote",
                    "version": __version__,
                    "installedWheelOnly": True,
                    "moduleOrigin": "certification_virtualenv",
                },
                "server": {
                    "requestedReference": args.image,
                    "resolvedImageId": image_id,
                    "platform": platform,
                    "exactPublishedDigest": True,
                    "oci": {
                        "version": labels["org.opencontainers.image.version"],
                        "revision": labels["org.opencontainers.image.revision"],
                        "source": labels["org.opencontainers.image.source"],
                        "license": labels["org.opencontainers.image.licenses"],
                    },
                },
                "journey": {
                    "oneUseEnrollment": True,
                    "secondRedemptionTypedError": "enrollment_consumed",
                    "initialRead": "empty",
                    "mutationCommitted": True,
                    "exactMutationReplay": True,
                    "postMutationRead": True,
                    "invalidCredentialTypedError": "invalid_token",
                },
                "isolation": {
                    "loopbackOnlyHostPort": True,
                    "readOnlyRootFilesystem": True,
                    "capabilitiesDropped": True,
                    "ephemeralVolumeRemoved": False,
                },
                "publicSupportClaim": False,
                "externalPublicationPerformedByHarness": False,
            }
    finally:
        run(["docker", "rm", "--force", container], allow_failure=True)
        volume_removal = run(
            ["docker", "volume", "rm", "--force", volume],
            allow_failure=True,
        )
        if volume_removal.returncode != 0:
            raise RuntimeError("ephemeral certification volume could not be removed")

    if evidence is None:
        raise RuntimeError("exact-artifact journey produced no evidence")
    evidence["isolation"]["ephemeralVolumeRemoved"] = True
    print(json.dumps(evidence, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
