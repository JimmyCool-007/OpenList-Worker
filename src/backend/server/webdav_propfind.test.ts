import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { Hono } from "hono"
import { saveDb } from "../internal/model/db"
import { PermissionBit } from "../pkg/permission"
import { webdavRouter } from "./webdav"

const hrefs = (xml: string) =>
  [...xml.matchAll(/<d:href>([^<]*)<\/d:href>/g)].map((match) => match[1])

test("WebDAV PROPFIND reports the target type and honors Depth: 0", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openlist-dav-propfind-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, "folder", "nested"), { recursive: true })
  fs.writeFileSync(path.join(root, "folder", "nested", "grandchild.txt"), "deep")
  fs.writeFileSync(path.join(root, "folder", "child.txt"), "child")

  await saveDb(
    {
      settings: [],
      users: [
        {
          id: 1,
          username: "alice",
          password: "",
          role: 0,
          permission:
            (1 << PermissionBit.WEBDAV_READ) |
            (1 << PermissionBit.WEBDAV_MANAGE) |
            (1 << PermissionBit.WRITE_CONTENT),
          base_path: "/local",
          disabled: false,
        },
      ],
      storages: [
        {
          id: "local-propfind",
          driver: "Local",
          mount_path: "/local",
          addition: JSON.stringify({ root_folder_path: root }),
          modified: "2026-01-01T00:00:00.000Z",
          disabled: false,
          status: "work",
        },
      ],
      shares: [],
      metas: [],
    },
    {},
  )

  const app = new Hono().route("/dav", webdavRouter)
  const auth = { Authorization: `Basic ${btoa("alice:")}` }
  const propfind = (url: string, depth: string) =>
    app.request(url, {
      method: "PROPFIND",
      headers: { ...auth, Depth: depth },
    })

  await t.test("file metadata after PUT", async () => {
    const url = "/dav/upload%20%26%20check.txt"
    const uploaded = await app.request(url, {
      method: "PUT",
      headers: auth,
      body: "test upload",
    })
    assert.equal(uploaded.status, 201)
    const modified = new Date("2026-10-04T12:34:56Z")
    fs.utimesSync(path.join(root, "upload & check.txt"), modified, modified)

    for (const depth of ["0", "1"]) {
      const response = await propfind(url, depth)
      assert.equal(response.status, 207)
      const xml = await response.text()
      assert.deepEqual(hrefs(xml), [url])
      assert.match(xml, /<d:resourcetype\/>/)
      assert.doesNotMatch(xml, /<d:collection\/>/)
      assert.match(xml, /<d:getcontentlength>11<\/d:getcontentlength>/)
      assert.ok(
        xml.includes(
          `<d:getlastmodified>${modified.toUTCString()}</d:getlastmodified>`,
        ),
      )
    }
  })

  await t.test("directory children appear only at Depth: 1", async () => {
    const self = await propfind("/dav/folder", "0")
    assert.equal(self.status, 207)
    const selfXml = await self.text()
    assert.deepEqual(hrefs(selfXml), ["/dav/folder/"])
    assert.match(selfXml, /<d:resourcetype><d:collection\/><\/d:resourcetype>/)

    const listing = await propfind("/dav/folder", "1")
    assert.equal(listing.status, 207)
    assert.deepEqual(hrefs(await listing.text()).sort(), [
      "/dav/folder/",
      "/dav/folder/child.txt",
      "/dav/folder/nested/",
    ])
  })

  await t.test("missing target returns 404", async () => {
    assert.equal((await propfind("/dav/missing.txt", "0")).status, 404)
  })
})
