#!/usr/bin/env python3
"""Fail-closed PyPI coordinate inspection for an idempotent protected release."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

VERSION = re.compile(r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$")
SHA256 = re.compile(r"^[a-f0-9]{64}$")
MAX_WHEEL_BYTES = 16 * 1024 * 1024


def normalize_project(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def read_url(url: str) -> bytes:
    with urllib.request.urlopen(url, timeout=30) as response:
        data = response.read(MAX_WHEEL_BYTES + 1)
    if len(data) > MAX_WHEEL_BYTES:
        raise RuntimeError(f"remote object exceeds {MAX_WHEEL_BYTES} bytes")
    return data


def require_url(url: str, *, production: bool) -> None:
    parsed = urllib.parse.urlparse(url)
    if (
        parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        raise RuntimeError("registry URLs must not contain credentials, query, or fragment")
    if production:
        if parsed.scheme != "https" or parsed.hostname not in {
            "pypi.org",
            "files.pythonhosted.org",
        } or parsed.port is not None:
            raise RuntimeError(f"refusing non-canonical PyPI URL: {url}")
    elif parsed.scheme not in {"http", "https"} or parsed.hostname not in {
        "127.0.0.1",
        "::1",
        "localhost",
    }:
        raise RuntimeError(f"test index must be loopback-only: {url}")
def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--candidate", required=True, type=Path)
    parser.add_argument("--package", required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--download-dir", required=True, type=Path)
    parser.add_argument("--index-base-url", default="https://pypi.org/pypi")
    parser.add_argument("--allow-insecure-loopback-test-index", action="store_true")
    args = parser.parse_args()

    if not VERSION.fullmatch(args.version):
        parser.error("--version must be stable SemVer")
    package = normalize_project(args.package)
    if package != args.package:
        parser.error("--package must already be PEP 503 normalized")

    candidate = args.candidate.resolve()
    if not candidate.is_file() or candidate.suffix != ".whl":
        parser.error("--candidate must be one wheel file")
    expected_filename = (
        f"{package.replace('-', '_')}-{args.version}-py3-none-any.whl"
    )
    if candidate.name != expected_filename:
        parser.error(f"--candidate must be named {expected_filename}")
    candidate_bytes = candidate.read_bytes()
    if len(candidate_bytes) > MAX_WHEEL_BYTES:
        raise RuntimeError(f"candidate exceeds {MAX_WHEEL_BYTES} bytes")

    production = not args.allow_insecure_loopback_test_index
    base_url = args.index_base_url.rstrip("/")
    if production and base_url != "https://pypi.org/pypi":
        parser.error("production inspection is pinned to https://pypi.org/pypi")
    metadata_url = (
        f"{base_url}/{urllib.parse.quote(package)}/"
        f"{urllib.parse.quote(args.version)}/json"
    )
    require_url(metadata_url, production=production)

    try:
        metadata_bytes = read_url(metadata_url)
    except urllib.error.HTTPError as error:
        if error.code == 404:
            print(json.dumps({
                "contractVersion": "tasq.pypi-publication-resume.v1",
                "state": "absent",
                "package": package,
                "version": args.version,
            }, sort_keys=True))
            return
        raise RuntimeError(
            f"PyPI metadata lookup failed with HTTP {error.code}"
        ) from error

    try:
        metadata = json.loads(metadata_bytes)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RuntimeError("PyPI returned invalid JSON metadata") from error
    if not isinstance(metadata, dict):
        raise RuntimeError("PyPI metadata must be an object")
    info = metadata.get("info")
    if (
        not isinstance(info, dict)
        or not isinstance(info.get("name"), str)
        or normalize_project(info["name"]) != package
        or info.get("version") != args.version
    ):
        raise RuntimeError("PyPI metadata identity does not match package and version")
    urls = metadata.get("urls")
    if not isinstance(urls, list):
        raise RuntimeError("PyPI metadata urls must be an array")
    wheels = [
        item
        for item in urls
        if isinstance(item, dict)
        and item.get("filename") == expected_filename
        and item.get("packagetype") == "bdist_wheel"
    ]
    if len(wheels) != 1:
        raise RuntimeError("PyPI must expose exactly one expected universal wheel")
    wheel = wheels[0]
    if wheel.get("yanked") not in {False, None}:
        raise RuntimeError("refusing to reuse a yanked PyPI wheel")
    digests = wheel.get("digests")
    declared_sha = digests.get("sha256") if isinstance(digests, dict) else None
    if not isinstance(declared_sha, str) or not SHA256.fullmatch(declared_sha):
        raise RuntimeError("PyPI wheel is missing an exact lowercase SHA-256")
    remote_url = wheel.get("url")
    if not isinstance(remote_url, str):
        raise RuntimeError("PyPI wheel URL is missing")
    require_url(remote_url, production=production)

    remote_bytes = read_url(remote_url)
    declared_size = wheel.get("size")
    if isinstance(declared_size, int) and declared_size != len(remote_bytes):
        raise RuntimeError("downloaded wheel size differs from PyPI metadata")
    remote_sha = hashlib.sha256(remote_bytes).hexdigest()
    candidate_sha = hashlib.sha256(candidate_bytes).hexdigest()
    if remote_sha != declared_sha:
        raise RuntimeError("downloaded wheel differs from PyPI SHA-256")
    if candidate_sha != declared_sha or candidate_bytes != remote_bytes:
        raise RuntimeError("existing PyPI wheel differs from protected candidate bytes")

    download_dir = args.download_dir.resolve()
    download_dir.mkdir(parents=True, exist_ok=True)
    if any(download_dir.iterdir()):
        parser.error("--download-dir must be empty")
    downloaded = download_dir / expected_filename
    downloaded.write_bytes(remote_bytes)
    print(json.dumps({
        "contractVersion": "tasq.pypi-publication-resume.v1",
        "state": "identical",
        "package": package,
        "version": args.version,
        "filename": expected_filename,
        "sha256": declared_sha,
        "downloadedWheel": str(downloaded),
    }, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"PyPI resume verification failed: {error}", file=sys.stderr)
        raise SystemExit(1) from error
