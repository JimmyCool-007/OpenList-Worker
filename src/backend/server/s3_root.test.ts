import assert from "node:assert/strict"
import test from "node:test"
import { isWithinUserRoot } from "../pkg/permission"
import { s3VirtualPath } from "./s3"

test("reserved S3 root bucket maps to scoped user's base_path without creating a root directory", () => {
  const user = { role: 0, permission: 8, base_path: "/drive" }
  assert.equal(s3VirtualPath(user, "root", ""), "/drive")
  assert.equal(s3VirtualPath(user, "root", "test.bin"), "/drive/test.bin")
  assert.equal(s3VirtualPath(user, "root", "subdir/test.bin"), "/drive/subdir/test.bin")
  assert.ok(isWithinUserRoot(user, s3VirtualPath(user, "root", "test.bin")))
})

test("ordinary S3 buckets retain their original scoped directory mapping", () => {
  const user = { role: 0, permission: 8, base_path: "/drive" }
  assert.equal(s3VirtualPath(user, "Document", ""), "/drive/Document")
  assert.equal(s3VirtualPath(user, "Document", "test.bin"), "/drive/Document/test.bin")
  assert.equal(s3VirtualPath(user, "another", "nested/file.bin"), "/drive/another/nested/file.bin")
})

test("reserved S3 root bucket also maps to the virtual root for an unrestricted user", () => {
  const user = { role: 0, permission: 8, base_path: "/" }
  assert.equal(s3VirtualPath(user, "root", ""), "/")
  assert.equal(s3VirtualPath(user, "root", "file.bin"), "/file.bin")
  assert.equal(s3VirtualPath(user, "drive", "file.bin"), "/drive/file.bin")
})
