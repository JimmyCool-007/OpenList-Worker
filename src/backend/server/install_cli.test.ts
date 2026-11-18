import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { test } from "node:test"
import app from "../index"

const script = await readFile(new URL("../../../scripts/install-cli.sh", import.meta.url), "utf8")

test("installer is served directly and exactly from both Worker routes", async () => {
  let assets = 0
  const env = { ASSETS: { async fetch() { assets++; return new Response("fallback") } } }
  for (const path of ["/i", "/install.sh"]) {
    for (const method of ["GET", "HEAD"]) {
      const r = await app.request("https://drive.jimmy007.com" + path, { method }, env)
      assert.equal(r.status, 200)
      assert.equal(r.headers.get("location"), null)
      assert.match(r.headers.get("content-type")!, /^text\/plain/)
      assert.equal(r.headers.get("cache-control"), "no-store")
      assert.equal(await r.text(), method === "HEAD" ? "" : script)
    }
  }
  assert.equal(assets, 0)
  assert.doesNotMatch(script, /github\.com|githubusercontent\.com/)
})

test("release routes expose only the allowed objects and reject writes", async () => {
  const keys: string[] = []
  const bucket = {
    async get(key: string) { keys.push(key); return { body: new Blob([key]).stream() } },
    async head(key: string) { keys.push(key); return {} },
  }
  const env = { R2: bucket, ASSETS: { async fetch() { throw new Error("unexpected assets fallback") } } }
  for (const suffix of ["latest", "0.1.5/ol-linux-amd64", "0.1.5/ol-linux-arm64", "0.1.5/SHA256SUMS"]) {
    for (const method of ["GET", "HEAD"]) {
      const r = await app.request("https://example.com/cli-releases/" + suffix, { method }, env)
      assert.equal(r.status, 200)
      assert.equal(await r.text(), method === "GET" ? "cli-releases/" + suffix : "")
      assert.equal(r.headers.get("x-content-type-options"), "nosniff")
    }
  }
  const initialCount = keys.length
  for (const suffix of ["x", "0.1.5/secret", "0.1.5/%2e%2e%2fsecret", "%2fsecret", "1.2.3.4/SHA256SUMS", "1.2.3/ol-linux-386", "1.2.3/SHA256SUMS/extra"]) {
    assert.equal((await app.request("https://example.com/cli-releases/" + suffix, {}, env)).status, 404, suffix)
  }
  for (const method of ["PUT", "POST", "DELETE", "PATCH"]) {
    assert.equal((await app.request("https://example.com/cli-releases/0.1.5/SHA256SUMS", { method }, env)).status, 405)
  }
  assert.equal(keys.length, initialCount)
})

test("missing release assets and coordinator fail closed", async () => {
  const env = { R2: { async get() { return null }, async head() { return null } } }
  assert.equal((await app.request("https://example.com/cli-releases/latest", {}, env)).status, 404)
  assert.equal((await app.request("https://example.com/cli-releases/ready", {}, env)).status, 503)
})
