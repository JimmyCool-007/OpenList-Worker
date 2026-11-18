import assert from "node:assert/strict"
import { test } from "node:test"
import app from "../index"

const upstream = "https://raw.githubusercontent.com/JimmyCool-007/OpenList-Worker/main/scripts/install-cli.sh"

test("custom-domain /install.sh and /i redirect to the maintained GitHub installer", async () => {
  let assetFetches = 0
  const env = {
    ASSETS: {
      fetch: async () => {
        assetFetches++
        return new Response("<html>SPA fallback</html>", {
          headers: { "Content-Type": "text/html" },
        })
      },
    },
  }
  for (const route of ["/install.sh", "/i"]) {
    for (const method of ["GET", "HEAD"]) {
      const response = await app.request("https://drive.jimmy007.com" + route, {
        method,
        headers: { accept: "text/html" },
      }, env)
      assert.equal(response.status, 302, method + " " + route)
      assert.equal(response.headers.get("Location"), upstream, method + " " + route)
      assert.equal(response.headers.get("Cache-Control"), "no-store", method + " " + route)
      assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff", method + " " + route)
      assert.notEqual(response.headers.get("Content-Type"), "text/html", method + " " + route)
      assert.equal(await response.text(), "", method + " " + route)
    }
  }
  assert.equal(assetFetches, 0, "the installer must bypass SPA and static assets")
})

test("installer route is exact and does not intercept the web UI", async () => {
  const env = {
    ASSETS: {
      fetch: async () => new Response("<html>OpenList</html>", {
        headers: { "Content-Type": "text/html" },
      }),
    },
  }
  const page = await app.request("https://drive.jimmy007.com/", {
    method: "GET",
    headers: { accept: "text/html" },
  }, env)
  assert.equal(page.status, 200)
  assert.match(await page.text(), /OpenList/)
  assert.equal(page.headers.get("Location"), null)
})
