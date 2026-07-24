#!/usr/bin/env python3
import base64
import json
import pathlib
import subprocess
import sys
import tempfile

vector = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))

def b64url(value):
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))

payload = b64url(vector["payload"])
payload_type = vector["payloadType"].encode("utf-8")
pae = (
    b"DSSEv1 " + str(len(payload_type)).encode() + b" " + payload_type +
    b" " + str(len(payload)).encode() + b" " + payload
)
if pae != b64url(vector["pae"]):
    raise SystemExit("PAE mismatch")

with tempfile.TemporaryDirectory(prefix="tasq-vector-") as directory:
    root = pathlib.Path(directory)
    (root / "public.pem").write_text(vector["publicKeyPem"], encoding="utf-8")
    (root / "pae.bin").write_bytes(pae)
    (root / "signature.bin").write_bytes(b64url(vector["signature"]))
    subprocess.run([
        "openssl", "pkeyutl", "-verify", "-pubin",
        "-inkey", str(root / "public.pem"), "-rawin",
        "-in", str(root / "pae.bin"), "-sigfile", str(root / "signature.bin")
    ], check=True, stdout=subprocess.DEVNULL)

print(json.dumps({"contractVersion": vector["contractVersion"], "verified": True}))
