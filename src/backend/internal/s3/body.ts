import { createHash } from "node:crypto"
import { fail, S3Failure } from "./protocol"

declare const FixedLengthStream: new (length: number) => {
  readable: ReadableStream<Uint8Array>
  writable: WritableStream<Uint8Array>
}

export type BodyChecksums = { md5?: string; sha256?: string }

export async function writeUploadBody<T>(
  input: ReadableStream<Uint8Array> | null,
  length: number,
  checksums: BodyChecksums,
  write: (body: ReadableStream<Uint8Array>) => Promise<T>,
): Promise<T> {
  const fixed = new FixedLengthStream(length)
  const hashes = (["md5", "sha256"] as const)
    .filter((name) => checksums[name])
    .map((name) => ({ hash: createHash(name), expected: checksums[name] }))
  let size = 0
  let last: Uint8Array | undefined
  let validationError: S3Failure | undefined
  const reject = (message: string) => {
    validationError = new S3Failure("BadDigest", message)
    throw validationError
  }
  const verified = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      size += chunk.byteLength
      if (size > length) reject("Body is larger than Content-Length")
      for (const { hash } of hashes) hash.update(chunk)
      // Do not let R2 finish writing until the input and its digest are verified.
      if (size === length && chunk.byteLength) {
        const end = chunk.byteLength - 1
        last = Uint8Array.of(chunk[end])
        if (end) controller.enqueue(chunk.subarray(0, end))
      } else if (chunk.byteLength) {
        controller.enqueue(chunk)
      }
    },
    flush(controller) {
      if (size !== length) reject("Body does not match Content-Length")
      for (const { hash, expected } of hashes) {
        if (hash.digest("hex") !== expected) reject("Body does not match its checksum")
      }
      if (last) controller.enqueue(last)
    },
  })
  if (!input && length > 0) fail("IncompleteBody", "Missing request body")
  const source = input ?? new ReadableStream<Uint8Array>({ start(controller) { controller.close() } })
  const abort = new AbortController()
  const piping = source.pipeThrough(verified).pipeTo(fixed.writable, { signal: abort.signal })
  // Attach both handlers immediately so that aborting either side unblocks the other.
  try {
    const [result] = await Promise.all([write(fixed.readable), piping])
    return result
  } catch (error) {
    abort.abort()
    await piping.catch(() => {})
    throw validationError ?? error
  }
}

export async function storeEmptyUpload<T>(
  input: ReadableStream<Uint8Array> | null,
  checksums: BodyChecksums,
  write: () => Promise<T>,
): Promise<T> {
  if (input) {
    const reader = input.getReader()
    try {
      for (;;) {
        const item = await reader.read()
        if (item.done) break
        if (item.value.byteLength) fail("IncompleteBody", "Expected an empty request body")
      }
    } finally {
      reader.releaseLock()
    }
  }
  for (const key of ["md5", "sha256"] as const) {
    if (checksums[key] && createHash(key).digest("hex") !== checksums[key]) {
      fail("BadDigest", "Body does not match its checksum")
    }
  }
  return write()
}
