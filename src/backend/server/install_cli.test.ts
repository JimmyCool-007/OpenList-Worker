import assert from "node:assert/strict"
import { test } from "node:test"
import app from "../index"

const upstream = "https://raw.githubusercontent.com/JimmyCool-007/OpenList-Worker/main/scripts/install-cli.sh"

test("custom-domain /install.sh redirects to the maintained GitHub installer", async () => {
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
  for (const method of ["GET", "HEAD"]) {
    const response = await app.request("https://drive.jimmy007.com/install.sh", {
      method,
      headers: { accept: "text/html" },
    }, env)
    assert.equal(response.status, 302, method)
    assert.equal(response.headers.get("Location"), upstream, method)
    assert.equal(response.headers.get("Cache-Control"), "no-store", method)
    assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff", method)
    assert.notEqual(response.headers.get("Content-Type"), "text/html", method)
    assert.equal(await response.text(), "", method)
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
