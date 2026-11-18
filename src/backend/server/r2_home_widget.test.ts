import assert from "node:assert/strict"
import { test } from "node:test"
import app from "../index"
import { s3Router } from "./s3"
import {
  injectR2HomeWidget, R2_HOME_WIDGET_JAVASCRIPT, R2_HOME_WIDGET_PATH,
} from "./r2-home-widget"

const sample = '<!doctype html><html><head><script>window.OPENLIST_CONFIG = {cdn: undefined}</script></head><body><div id="root"></div></body></html>'

test("R2 widget bootstrap is restricted to OpenList HTML and idempotent", () => {
  const first = injectR2HomeWidget(sample)
  assert.match(first, /<script defer src="\/ol-r2-home-widget\.js" data-ol-r2-home-widget><\/script><\/body>/)
  assert.equal(injectR2HomeWidget(first), first, "CDN/runtime/bootstrap must not inject twice")
  assert.equal(injectR2HomeWidget("<!doctype html><body>Not an OpenList frontend</body>"), "<!doctype html><body>Not an OpenList frontend</body>")
  assert.equal(injectR2HomeWidget("<html><head>window.OPENLIST_CONFIG</head></html>"), "<html><head>window.OPENLIST_CONFIG</head></html>")
  assert.doesNotThrow(() => new Function(R2_HOME_WIDGET_JAVASCRIPT), "the served browser widget must parse")
})

test("Home serves widget script with proper MIME and injects bootstrap above SPA", async () => {
  const env = {
    ASSETS: {
      fetch: async () => new Response(sample, {
        headers: { "content-type": "text/html", etag: '"outdated-etag"' },
      }),
    },
  }
  const response = await app.request("https://drive.jimmy007.com/", {
    headers: { Accept: "text/html" },
  }, env)
  assert.equal(response.status, 200)
  const html = await response.text()
  assert.match(html, /data-ol-r2-home-widget/)
  assert.match(html, /<div id="root"><\/div>/)
  assert.equal(response.headers.get("etag"), null, "HTML content changed; stale ETag must be cleared")

  const script = await app.request("https://drive.jimmy007.com" + R2_HOME_WIDGET_PATH, {
    headers: { Accept: "application/javascript" },
  }, env)
  assert.equal(script.status, 200)
  assert.match(script.headers.get("content-type") || "", /^application\/javascript/)
  assert.equal(script.headers.get("X-Content-Type-Options"), "nosniff")
  const javascript = await script.text()
  assert.match(javascript, /\.body \.nav/)
  assert.match(javascript, /openlist-quota/)
})

test("R2 quota endpoint still rejects unauthenticated viewers", async () => {
  const response = await s3Router.request("https://example.test/", { method: "GET" }, {})
  assert.equal(response.status, 403)
  assert.doesNotMatch(await response.text(), /externalObjects|reserved|limitBytes/)
})
