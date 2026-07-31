#!/usr/bin/env python3
"""Build the dependency-free Tasq Python wheel from explicit, clock-free inputs."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import re
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
VERSION = re.compile(r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$")
COMMIT = re.compile(r"^[a-f0-9]{40}$")
DIST = "tasq_remote"
PROJECT = "tasq-remote"
ZIP_TIME = (1980, 1, 1, 0, 0, 0)


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def record_digest(data: bytes) -> str:
    encoded = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=")
    return f"sha256={encoded.decode('ascii')}"


def metadata(version: str, readme: str) -> bytes:
    return (
        "Metadata-Version: 2.3\n"
        f"Name: {PROJECT}\n"
        f"Version: {version}\n"
        "Summary: Thin authenticated Python client for Tasq Server\n"
        "License: Apache-2.0\n"
        "License-File: LICENSE\n"
        "Requires-Python: >=3.11\n"
        "Project-URL: Homepage, https://tasq.run\n"
        "Project-URL: Repository, https://github.com/gwendall/tasq\n"
        "Description-Content-Type: text/markdown\n"
        "\n"
        f"{readme.rstrip()}\n"
    ).encode()


def wheel_entry(path: str, data: bytes) -> tuple[zipfile.ZipInfo, bytes]:
    info = zipfile.ZipInfo(path, ZIP_TIME)
    info.compress_type = zipfile.ZIP_STORED
    info.external_attr = 0o100644 << 16
    info.create_system = 3
    return info, data


def write_json(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--version", required=True)
    parser.add_argument("--source-commit", required=True)
    parser.add_argument("--outdir", required=True, type=Path)
    args = parser.parse_args()
    if not VERSION.fullmatch(args.version):
        parser.error("--version must be stable SemVer")
    if not COMMIT.fullmatch(args.source_commit):
        parser.error("--source-commit must be a lowercase 40-character Git commit")

    outdir = args.outdir.resolve()
    outdir.mkdir(parents=True, exist_ok=True)
    if any(outdir.iterdir()):
        parser.error("--outdir must be empty")

    package = ROOT / "clients/python/tasq_remote/__init__.py"
    module = package.read_text(encoding="utf-8")
    module, replacements = re.subn(
        r'^__version__ = "[^"]+"$',
        f'__version__ = "{args.version}"',
        module,
        count=1,
        flags=re.MULTILINE,
    )
    if replacements != 1:
        raise RuntimeError("Python client must declare exactly one __version__")
    readme = (ROOT / "clients/python/README.md").read_text(encoding="utf-8")
    license_bytes = (ROOT / "LICENSE").read_bytes()
    dist_info = f"{DIST}-{args.version}.dist-info"
    entries: dict[str, bytes] = {
        f"{DIST}/__init__.py": module.encode(),
        f"{dist_info}/LICENSE": license_bytes,
        f"{dist_info}/METADATA": metadata(args.version, readme),
        f"{dist_info}/WHEEL": (
            "Wheel-Version: 1.0\n"
            "Generator: tasq-protected-python-wheel-builder\n"
            "Root-Is-Purelib: true\n"
            "Tag: py3-none-any\n"
        ).encode(),
    }
    record_path = f"{dist_info}/RECORD"
    record = "".join(
        f"{path},{record_digest(data)},{len(data)}\n"
        for path, data in sorted(entries.items())
    ) + f"{record_path},,\n"
    entries[record_path] = record.encode()

    wheel_name = f"{DIST}-{args.version}-py3-none-any.whl"
    wheel_path = outdir / wheel_name
    with zipfile.ZipFile(
        wheel_path,
        "w",
        compression=zipfile.ZIP_STORED,
        strict_timestamps=True,
    ) as archive:
        for path, data in sorted(entries.items()):
            archive.writestr(*wheel_entry(path, data))

    wheel_sha = digest(wheel_path.read_bytes())
    prefix = f"tasq-python-v{args.version}"
    sbom_name = f"{prefix}.cdx.json"
    release_name = f"{prefix}.release.json"
    package_purl = f"pkg:pypi/{PROJECT}@{args.version}"
    write_json(outdir / sbom_name, {
        "$schema": "http://cyclonedx.org/schema/bom-1.6.schema.json",
        "bomFormat": "CycloneDX",
        "specVersion": "1.6",
        "version": 1,
        "metadata": {
            "component": {
                "bom-ref": package_purl,
                "type": "library",
                "name": PROJECT,
                "version": args.version,
                "purl": package_purl,
                "licenses": [{
                    "license": {
                        "id": "Apache-2.0",
                    },
                }],
            },
            "properties": [
                {"name": "tasq:sourceCommit", "value": args.source_commit},
                {"name": "tasq:authoritativeTime", "value": "not-read-build-inputs-only"},
            ],
        },
        "components": [],
        "dependencies": [{
            "ref": package_purl,
            "dependsOn": [],
        }],
    })
    write_json(outdir / release_name, {
        "contractVersion": "tasq.python-wheel-release.v1",
        "package": PROJECT,
        "version": args.version,
        "source": {
            "repository": "https://github.com/gwendall/tasq",
            "commit": args.source_commit,
        },
        "wheel": {
            "filename": wheel_name,
            "sha256": wheel_sha,
            "tag": "py3-none-any",
            "minimumPython": "3.11",
            "runtimeDependencies": [],
        },
        "provenance": {
            "requiredBuilder": "protected-github-actions-publication-workflow",
            "pypiPublishing": "trusted-publishing-oidc",
            "localArtifactsPublishable": False,
        },
        "clockBoundary": "explicit inputs only; no device time is build authority",
    })
    checksums = [
        (wheel_name, wheel_sha),
        (sbom_name, digest((outdir / sbom_name).read_bytes())),
        (release_name, digest((outdir / release_name).read_bytes())),
    ]
    (outdir / f"{prefix}.SHA256SUMS").write_text(
        "".join(f"{sha}  {name}\n" for name, sha in sorted(checksums)),
        encoding="utf-8",
    )
    print(json.dumps({
        "contractVersion": "tasq.python-wheel-build.v1",
        "wheel": str(wheel_path),
        "sha256": wheel_sha,
    }, sort_keys=True))


if __name__ == "__main__":
    main()
