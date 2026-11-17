import { GoogleDrive } from "../../drivers/google_drive/driver"
import { driveChildren, driveParent } from "../../drivers/google_drive/resumable"
import { getDb, resolvePath } from "../model/db"
import { getDriver } from "../op/storage"
import { canWrite, getActualPath, isWithinUserRoot } from "../../pkg/permission"
import { canAccess, canWrite as canWriteMeta, getNearestMeta } from "../../pkg/meta"
import { fail } from "./protocol"
import type { UploadEnv, UploadScope, UploadTarget } from "./protocol"

export async function authorizeUpload(env: UploadEnv, scope: UploadScope) {
  const db = await getDb(env)
  const user = db.users?.find((entry: { id: number }) => entry.id === scope.owner)
  const parent = scope.path.slice(0, scope.path.lastIndexOf("/")) || "/"
  // Background tasks do not keep directory passwords. They must remain accessible
  // to the owning user without an auxiliary password throughout the transfer.
  if (!user || !canWrite(user) || !isWithinUserRoot(user, scope.path) ||
      !isWithinUserRoot(user, parent) || getActualPath(user, "/") === scope.path ||
      !canAccess(user, await getNearestMeta(scope.path, env), scope.path) ||
      !canAccess(user, await getNearestMeta(parent, env), parent) ||
      !canWriteMeta(user, await getNearestMeta(parent, env), parent) ||
      !canWriteMeta(user, await getNearestMeta(scope.path, env), scope.path)) {
    fail("AccessDenied", "Upload path must remain writable and accessible to its owner", 403)
  }
}

async function driveContext(env: UploadEnv, path: string, storageId?: number) {
  const resolved = await resolvePath(path, env)
  const storage = resolved.storage
  if (!storage || resolved.cleanPath !== path || resolved.relative === "/" ||
      !resolved.physical || (storageId !== undefined && storage.id !== storageId)) {
    fail("InvalidRequest", "The Google Drive mount is unavailable or has changed", 409)
  }
  const driver = await getDriver(storage.driver, storage)
  if (!(driver instanceof GoogleDrive)) {
    fail("NotImplemented", "Staged uploads require a Google Drive mount", 501)
  }
  return { client: driver.getUploadClient(), physical: resolved.physical, storageId: storage.id as number }
}

export async function resolveUploadTarget(env: UploadEnv, scope: UploadScope): Promise<UploadTarget> {
  await authorizeUpload(env, scope)
  const { client, physical, storageId } = await driveContext(env, scope.path)
  const target = await driveParent(client, physical)
  if ((await driveChildren(client, target.parentId, target.name)).length) {
    fail("PreconditionFailed", "A Drive item with that name already exists", 412)
  }
  return { path: scope.path, storageId, ...target }
}

export async function loadUploadTarget(env: UploadEnv, scope: UploadScope, target: UploadTarget, verifyParent: boolean) {
  await authorizeUpload(env, scope)
  const { client, physical } = await driveContext(env, scope.path, target.storageId)
  if (verifyParent) {
    const actual = await driveParent(client, physical)
    if (actual.rootId !== target.rootId || actual.parentId !== target.parentId || actual.name !== target.name) {
      fail("InvalidRequest", "The pinned Google Drive destination changed", 409)
    }
  }
  return client
}
