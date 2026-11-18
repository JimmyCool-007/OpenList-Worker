#!/usr/bin/env python3
"""Publish immutable CLI assets, verify them from R2, then switch latest."""
import base64
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import sys
import time

PREFIX = "cli-releases/"
BUDGET = 256 * 1024 * 1024  # Must match CLI_RELEASE_BUDGET in protocol.ts.
ASSETS = ("ol-linux-amd64", "ol-linux-arm64", "SHA256SUMS")
VERSION = re.compile(r"^[0-9]{1,9}\.[0-9]{1,9}\.[0-9]{1,9}$")


def scoped_credentials(account, access, secret, now=None):
    """R2 local temporary credentials: no business keys or delete operations."""
    now = int(time.time()) if now is None else now
    def encode(value):
        return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")
    header = {"alg": "HS256", "typ": "JWT"}
    claims = {
        "bucket": "data", "actions": ["ListObjectsV2", "GetObject", "PutObject"],
        "paths": {"prefixPaths": [PREFIX], "objectPaths": []},
        "sub": account, "iss": access, "aud": account + ".r2.cloudflarestorage.com",
        "iat": now, "exp": now + 900,
    }
    token = ".".join(encode(json.dumps(x, separators=(",", ":")).encode()) for x in (header, claims))
    token += "." + encode(hmac.new(secret.encode(), token.encode(), hashlib.sha256).digest())
    return access, checksum(token.encode()), base64.b64encode(("jwt/" + token).encode()).decode()


def checksum(data):
    return hashlib.sha256(data).hexdigest()


def read_release(directory):
    data = {name: (directory / name).read_bytes() for name in ASSETS}
    lines = data["SHA256SUMS"].decode("ascii").splitlines()
    entries = {}
    for line in lines:
        match = re.fullmatch(r"([a-f0-9]{64})  (ol-linux-(?:amd64|arm64))", line)
        if not match or match.group(2) in entries:
            raise ValueError("invalid checksum manifest")
        entries[match.group(2)] = match.group(1)
    if set(entries) != set(ASSETS[:2]) or any(checksum(data[n]) != entries[n] for n in ASSETS[:2]):
        raise ValueError("release files do not match checksum manifest")
    return data


def absent(error):
    response = getattr(error, "response", {})
    return str(response.get("Error", {}).get("Code")) in ("404", "NoSuchKey", "NotFound")


def get_optional(client, bucket, key):
    try:
        response = client.get_object(Bucket=bucket, Key=key)
        return response["Body"].read(), response["ETag"]
    except Exception as error:
        if absent(error):
            return None, None
        raise


def preflight(client):
    client.list_objects_v2(Bucket="data", Prefix=PREFIX, MaxKeys=1)
    try:
        # A valid R2 object ETag is an MD5/multipart digest; this deliberately
        # impossible ETag ensures the authorized write always fails atomically.
        client.put_object(Bucket="data", Key=PREFIX + ".preflight-write-check", Body=b"",
                          IfMatch='"not-an-r2-object-etag"')
    except Exception as error:
        response = getattr(error, "response", {})
        if str(response.get("Error", {}).get("Code")) in ("412", "PreconditionFailed"):
            print("R2 release namespace read and conditional write access verified")
            return
        raise
    raise ValueError("R2 accepted an impossible preflight condition")


def publish(client, bucket, version, directory):
    if not VERSION.fullmatch(version):
        raise ValueError("invalid version")
    data = read_release(Path(directory))
    pointer_key = PREFIX + "latest"
    current, pointer_etag = get_optional(client, bucket, pointer_key)
    if current is not None:
        current_version = current.decode("ascii").strip()
        if not VERSION.fullmatch(current_version):
            raise ValueError("existing latest pointer is invalid")
        if tuple(map(int, current_version.split("."))) > tuple(map(int, version.split("."))):
            raise ValueError("refusing to move latest backwards")

    # Count every object in the namespace, including unknown or partial releases.
    # Never delete them and never rely on a list with an unbounded page size.
    existing = {}
    for page in client.get_paginator("list_objects_v2").paginate(Bucket=bucket, Prefix=PREFIX):
        for item in page.get("Contents", []):
            existing[item["Key"]] = item["Size"]
    new_keys = {PREFIX + version + "/" + name: body for name, body in data.items()}
    additional = sum(len(body) for key, body in new_keys.items() if key not in existing)
    # Count the new pointer in addition to the old one for a conservative bound.
    if sum(existing.values()) + additional + len(version) + 1 > BUDGET:
        raise ValueError("CLI release namespace exceeds its reserved R2 budget")

    for key, body in new_keys.items():
        if key not in existing:
            # Atomic: a concurrent writer may not replace an immutable version.
            client.put_object(Bucket=bucket, Key=key, Body=body, IfNoneMatch="*")
        remote, _ = get_optional(client, bucket, key)
        if remote is None or checksum(remote) != checksum(body):
            raise ValueError("R2 verification failed for " + key)
    # Every downloaded R2 object, including SHA256SUMS, was verified above.
    # Conditional pointer update prevents a concurrent publisher from rolling it back.
    if current != (version + "\n").encode():
        condition = {"IfMatch": pointer_etag} if pointer_etag else {"IfNoneMatch": "*"}
        client.put_object(Bucket=bucket, Key=pointer_key, Body=(version + "\n").encode(), **condition)
    result, _ = get_optional(client, bucket, pointer_key)
    if result != (version + "\n").encode():
        raise ValueError("latest pointer verification failed")
    print("Verified R2 CLI release", version)


def main():
    if len(sys.argv) not in (2, 3) or (len(sys.argv) == 2 and sys.argv[1] != "--preflight"):
        raise SystemExit("usage: publish-cli-r2.py --preflight | VERSION RELEASE_DIRECTORY")
    import boto3
    account = os.environ["CF_ACCOUNT_ID"]
    if not re.fullmatch(r"[0-9a-fA-F]{32}", account):
        raise ValueError("invalid Cloudflare account ID")
    access, secret, session = scoped_credentials(account, os.environ["R2_ACCESS_KEY_ID"], os.environ["R2_SECRET_ACCESS_KEY"])
    client = boto3.client(
        "s3", endpoint_url="https://" + account + ".r2.cloudflarestorage.com", region_name="auto",
        aws_access_key_id=access, aws_secret_access_key=secret, aws_session_token=session,
    )
    if sys.argv[1] == "--preflight":
        preflight(client)
        return
    publish(client, "data", sys.argv[1], Path(sys.argv[2]))


if __name__ == "__main__":
    main()
