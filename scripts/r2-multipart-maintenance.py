#!/usr/bin/env python3
"""Manual, exact-match R2 multipart audit/abort. Never deletes completed objects."""
import argparse
import datetime as dt
import json
import os
import sys
import boto3
from botocore.config import Config

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--mode", choices=["scan", "abort"], required=True)
    p.add_argument("--key", default="")
    p.add_argument("--upload-id", default="")
    p.add_argument("--initiated", default="")
    p.add_argument("--confirm", default="")
    a = p.parse_args()
    bucket = os.environ["R2_BUCKET"]
    account = os.environ["CF_ACCOUNT_ID"]
    client = boto3.client(
        "s3",
        endpoint_url=f"https://{account}.r2.cloudflarestorage.com",
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
        region_name="auto",
        config=Config(signature_version="s3v4", retries={"max_attempts": 3, "mode": "standard"}),
    )
    if a.mode == "abort":
        if not all([a.key, a.upload_id, a.initiated]) or a.confirm != "ABORT_EXACT_UPLOAD":
            p.error("abort requires --key, --upload-id, --initiated, and --confirm ABORT_EXACT_UPLOAD")
    now = dt.datetime.now(dt.timezone.utc)
    count = 0
    found = False
    for page in client.get_paginator("list_multipart_uploads").paginate(Bucket=bucket):
        for u in page.get("Uploads", []):
            key, upload_id = u["Key"], u["UploadId"]
            initiated = u["Initiated"].astimezone(dt.timezone.utc)
            timestamp = initiated.isoformat().replace("+00:00", "Z")
            age_hours = (now - initiated).total_seconds() / 3600
            count += 1
            if a.mode == "scan":
                print(json.dumps({"key": key, "upload_id": upload_id, "initiated": timestamp, "age_hours": round(age_hours, 1)}, ensure_ascii=False))
                continue
            if key == a.key and upload_id == a.upload_id:
                found = True
                if timestamp != a.initiated:
                    raise SystemExit("Refusing abort: initiated timestamp mismatch")
                if age_hours < 24:
                    raise SystemExit("Refusing abort: upload younger than 24 hours")
                # This tool does not know Durable Object state. Operator must independently
                # confirm this exact upload is abandoned before approving the workflow.
                client.abort_multipart_upload(Bucket=bucket, Key=key, UploadId=upload_id)
                print(json.dumps({"aborted": True, "key": key, "upload_id": upload_id}))
                return
    if a.mode == "abort":
        raise SystemExit("Upload not found; nothing aborted")
    print(f"Scanned {count} unfinished multipart uploads", file=sys.stderr)

if __name__ == "__main__":
    main()
