import importlib.util
import io
import base64
import hashlib
import hmac
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("publisher", Path(__file__).with_name("publish-cli-r2.py"))
pub = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pub)


class Missing(Exception):
    response = {"Error": {"Code": "NoSuchKey"}}


class PreconditionFailed(Exception):
    response = {"Error": {"Code": "PreconditionFailed"}}


class FakeS3:
    def __init__(self):
        self.objects = {"business/keep": b"untouched"}
        self.puts = []
        self.bad_key = None

    def get_paginator(self, name):
        assert name == "list_objects_v2"
        return self

    def list_objects_v2(self, Bucket, Prefix, MaxKeys):
        return {"Contents": []}

    def paginate(self, Bucket, Prefix):
        matching = [{"Key": k, "Size": len(v)} for k, v in self.objects.items() if k.startswith(Prefix)]
        yield {"Contents": matching[:2]}
        yield {"Contents": matching[2:]}

    def get_object(self, Bucket, Key):
        if Key not in self.objects:
            raise Missing()
        body = self.objects[Key]
        if Key == self.bad_key:
            body = b"corrupted"
        return {"Body": io.BytesIO(body), "ETag": '"' + pub.checksum(self.objects[Key]) + '"'}

    def put_object(self, Bucket, Key, Body, **conditions):
        old = self.objects.get(Key)
        if conditions.get("IfNoneMatch") == "*" and old is not None:
            raise ValueError("conditional write conflict")
        if "IfMatch" in conditions and (old is None or conditions["IfMatch"] != '"' + pub.checksum(old) + '"'):
            raise PreconditionFailed()
        self.puts.append(Key)
        self.objects[Key] = Body


class PublisherTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.directory = Path(self.tmp.name)
        self.addCleanup(self.tmp.cleanup)
        self.s3 = FakeS3()
        for name in pub.ASSETS[:2]:
            (self.directory / name).write_bytes(name.encode())
        manifest = "".join(pub.checksum((self.directory / name).read_bytes()) + "  " + name + "\n" for name in pub.ASSETS[:2])
        (self.directory / "SHA256SUMS").write_text(manifest)

    def test_publish_verifies_assets_before_pointer_and_is_idempotent(self):
        pub.publish(self.s3, "data", "0.1.5", self.directory)
        self.assertEqual(self.s3.puts[-1], "cli-releases/latest")
        self.assertEqual(self.s3.objects["cli-releases/latest"], b"0.1.5\n")
        self.assertEqual(self.s3.objects["business/keep"], b"untouched")
        before = len(self.s3.puts)
        pub.publish(self.s3, "data", "0.1.5", self.directory)
        self.assertEqual(len(self.s3.puts), before)
        with self.assertRaisesRegex(ValueError, "backwards"):
            pub.publish(self.s3, "data", "0.1.4", self.directory)

    def test_corruption_never_switches_latest(self):
        self.s3.bad_key = "cli-releases/0.1.5/ol-linux-arm64"
        with self.assertRaisesRegex(ValueError, "verification failed"):
            pub.publish(self.s3, "data", "0.1.5", self.directory)
        self.assertNotIn("cli-releases/latest", self.s3.objects)

    def test_immutable_conflict_and_invalid_local_checksum(self):
        self.s3.objects["cli-releases/0.1.5/ol-linux-amd64"] = b"different"
        with self.assertRaisesRegex(ValueError, "verification failed"):
            pub.publish(self.s3, "data", "0.1.5", self.directory)
        self.assertNotIn("cli-releases/latest", self.s3.objects)
        (self.directory / "ol-linux-amd64").write_bytes(b"tampered")
        before = len(self.s3.puts)
        with self.assertRaisesRegex(ValueError, "manifest"):
            pub.publish(self.s3, "data", "0.1.6", self.directory)
        self.assertEqual(len(self.s3.puts), before)

    def test_budget_counts_all_prefix_objects_and_blocks_writes(self):
        old_budget = pub.BUDGET
        pub.BUDGET = 5
        self.addCleanup(setattr, pub, "BUDGET", old_budget)
        self.s3.objects["cli-releases/unrecognized"] = b"123456"
        with self.assertRaisesRegex(ValueError, "budget"):
            pub.publish(self.s3, "data", "0.1.5", self.directory)
        self.assertEqual(self.s3.puts, [])

    def test_rejects_untrusted_version(self):
        with self.assertRaises(ValueError):
            pub.publish(self.s3, "data", "../business", self.directory)
        self.assertEqual(self.s3.puts, [])

    def test_temporary_credential_is_prefix_and_action_scoped(self):
        access, secret, session = pub.scoped_credentials("a" * 32, "parent-id", "parent-secret", now=100)
        self.assertEqual(access, "parent-id")
        token = base64.b64decode(session).decode().removeprefix("jwt/")
        header, body, signature = token.split(".")
        decode = lambda value: base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
        claims = json.loads(decode(body))
        self.assertEqual(claims["paths"], {"prefixPaths": ["cli-releases/"], "objectPaths": []})
        self.assertEqual(claims["actions"], ["ListObjectsV2", "GetObject", "PutObject"])
        self.assertEqual(claims["exp"] - claims["iat"], 900)
        self.assertEqual(decode(signature), hmac.new(b"parent-secret", (header + "." + body).encode(), hashlib.sha256).digest())
        self.assertEqual(secret, hashlib.sha256(token.encode()).hexdigest())

    def test_preflight_requires_write_without_modifying_any_object(self):
        before = dict(self.s3.objects)
        pub.preflight(self.s3)
        self.assertEqual(self.s3.objects, before)
        self.assertEqual(self.s3.puts, [])


if __name__ == "__main__":
    unittest.main()
