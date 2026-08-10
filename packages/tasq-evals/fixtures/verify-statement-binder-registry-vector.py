#!/usr/bin/env python3
import hashlib
import json
import pathlib
import sys

vector = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
descriptor = vector["descriptor"]
canonical = json.dumps(
    descriptor,
    ensure_ascii=False,
    separators=(",", ":"),
    sort_keys=True,
)
if canonical != vector["canonicalDescriptor"]:
    raise SystemExit("canonical descriptor mismatch")
digest = "sha256:" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()
if digest != vector["descriptorDigest"]:
    raise SystemExit("descriptor digest mismatch")
if descriptor["contractVersion"] != "tasq.statement-binder.v1":
    raise SystemExit("unsupported descriptor contract")
if not descriptor["binderImplementationDigest"].startswith("sha256:"):
    raise SystemExit("implementation digest is not pinned")
if len(vector["rejections"]) != len(set(vector["rejections"])):
    raise SystemExit("duplicate rejection identity")

print(json.dumps({
    "contractVersion": vector["contractVersion"],
    "descriptorDigest": digest,
    "verified": True,
}))
