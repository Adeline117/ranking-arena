import { createHash } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { extname, isAbsolute, join, relative } from 'node:path'
import { TextDecoder } from 'node:util'
import { deserialize, serialize } from 'node:v8'

import { parseStrictJson } from '../../lib/ingest/onchain/strict-json'
import { strictCanonicalJson } from './dex-contract-hash'

export const DEX_STRICT_JSON_MAX_BYTES_BY_PROFILE = Object.freeze({
  trusted_roots_candidate: 1024 * 1024,
  golden_wallet_snapshot: 2 * 1024 * 1024,
  acquisition_run_manifest: 1024 * 1024,
  acquisition_transcript: 16 * 1024 * 1024,
  endpoint_registry: 2 * 1024 * 1024,
  query_template: 1024 * 1024,
  adapter_toolchain: 1024 * 1024,
  boundary_evidence: 1024 * 1024,
  finality_anchor: 1024 * 1024,
  protocol_manifest: 4 * 1024 * 1024,
} as const)

export type DexStrictJsonSizeProfile = keyof typeof DEX_STRICT_JSON_MAX_BYTES_BY_PROFILE

export const DEX_STRICT_JSON_ERROR_CODES = Object.freeze([
  'INVALID_INPUT',
  'INVALID_ROOT',
  'INVALID_RELATIVE_PATH',
  'PATH_OUTSIDE_ROOT',
  'SYMLINK_REJECTED',
  'NOT_REGULAR_FILE',
  'FILE_TOO_LARGE',
  'FILE_CHANGED_DURING_READ',
  'FILE_READ_FAILED',
  'BOM_REJECTED',
  'INVALID_UTF8',
  'INVALID_STRICT_JSON',
] as const)

export type DexStrictJsonErrorCode = (typeof DEX_STRICT_JSON_ERROR_CODES)[number]

declare const STRICT_JSON_DOCUMENT_TYPE: unique symbol

type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T

type StrictJsonDocumentState = Readonly<{
  declared_size_profile: DexStrictJsonSizeProfile
  raw_sha256: string
  byte_length: number
  value: DeepReadonly<unknown>
}>

export type DexStrictJsonDocument = Readonly<{
  [STRICT_JSON_DOCUMENT_TYPE]: true
  toJSON(): never
}>

export type DexStrictJsonDocumentInspection = StrictJsonDocumentState

export type DexStrictJsonDocumentInput = Readonly<{
  rootPath: string
  relativePath: string
  sizeProfile: DexStrictJsonSizeProfile
}>

const STRICT_JSON_DOCUMENT_STATES = new WeakMap<object, StrictJsonDocumentState>()
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf])
const UTF16_BE_BOM = Buffer.from([0xfe, 0xff])
const UTF16_LE_BOM = Buffer.from([0xff, 0xfe])
const UTF32_BE_BOM = Buffer.from([0x00, 0x00, 0xfe, 0xff])
const UTF32_LE_BOM = Buffer.from([0xff, 0xfe, 0x00, 0x00])
const FORBIDDEN_BOMS = [UTF8_BOM, UTF16_BE_BOM, UTF16_LE_BOM, UTF32_BE_BOM, UTF32_LE_BOM]

export class DexStrictJsonDocumentError extends Error {
  readonly code: DexStrictJsonErrorCode
  readonly sizeProfile: DexStrictJsonSizeProfile | null

  constructor(code: DexStrictJsonErrorCode, sizeProfile: DexStrictJsonSizeProfile | null = null) {
    super(
      sizeProfile === null
        ? `DEX strict JSON document rejected: ${code}`
        : `DEX strict JSON document rejected: ${code} (${sizeProfile})`
    )
    this.name = 'DexStrictJsonDocumentError'
    this.code = code
    this.sizeProfile = sizeProfile
  }
}

function reject(
  code: DexStrictJsonErrorCode,
  sizeProfile: DexStrictJsonSizeProfile | null = null
): never {
  throw new DexStrictJsonDocumentError(code, sizeProfile)
}

function isSizeProfile(value: unknown): value is DexStrictJsonSizeProfile {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(DEX_STRICT_JSON_MAX_BYTES_BY_PROFILE, value)
  )
}

type UntrustedInputFields = Readonly<{
  rootPath: unknown
  relativePath: unknown
  sizeProfile: unknown
}>

function extractUntrustedInputFields(input: unknown): UntrustedInputFields | null {
  try {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) return null
    const prototype = Object.getPrototypeOf(input)
    if (prototype !== Object.prototype && prototype !== null) return null

    const expectedKeys = ['rootPath', 'relativePath', 'sizeProfile'] as const
    const ownKeys = Reflect.ownKeys(input)
    if (
      ownKeys.length !== expectedKeys.length ||
      ownKeys.some(
        (key) => typeof key !== 'string' || !expectedKeys.some((expected) => expected === key)
      )
    ) {
      return null
    }

    const descriptors = expectedKeys.map((key) => Object.getOwnPropertyDescriptor(input, key))
    if (
      descriptors.some(
        (descriptor) => !descriptor || !descriptor.enumerable || !('value' in descriptor)
      )
    ) {
      return null
    }
    return {
      rootPath: descriptors[0]?.value,
      relativePath: descriptors[1]?.value,
      sizeProfile: descriptors[2]?.value,
    }
  } catch {
    return null
  }
}

function validateInput(input: unknown): {
  rootPath: string
  relativePath: string
  sizeProfile: DexStrictJsonSizeProfile
  pathSegments: string[]
} {
  const values = extractUntrustedInputFields(input)
  if (values === null) return reject('INVALID_INPUT')
  const rootPath = values.rootPath
  const relativePath = values.relativePath
  const sizeProfile = values.sizeProfile
  if (!isSizeProfile(sizeProfile)) return reject('INVALID_INPUT')
  if (typeof rootPath !== 'string' || rootPath.length === 0 || !isAbsolute(rootPath)) {
    return reject('INVALID_ROOT', sizeProfile)
  }
  if (
    typeof relativePath !== 'string' ||
    relativePath.length === 0 ||
    relativePath.includes('\0') ||
    relativePath.includes('\\') ||
    isAbsolute(relativePath) ||
    extname(relativePath) !== '.json'
  ) {
    return reject('INVALID_RELATIVE_PATH', sizeProfile)
  }
  const pathSegments = relativePath.split('/')
  if (
    pathSegments.length === 0 ||
    pathSegments.some(
      (segment) => segment === '.' || segment === '..' || !SAFE_PATH_SEGMENT.test(segment)
    )
  ) {
    return reject('INVALID_RELATIVE_PATH', sizeProfile)
  }
  return { rootPath, relativePath, sizeProfile, pathSegments }
}

function isPathInsideRoot(rootPath: string, candidatePath: string): boolean {
  const relativePath = relative(rootPath, candidatePath)
  return (
    relativePath === '' ||
    (!isAbsolute(relativePath) &&
      relativePath !== '..' &&
      !relativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`))
  )
}

async function resolveRegularFile(
  rootPath: string,
  pathSegments: readonly string[],
  sizeProfile: DexStrictJsonSizeProfile
): Promise<string> {
  let rootStats
  try {
    rootStats = await lstat(rootPath)
  } catch {
    return reject('INVALID_ROOT', sizeProfile)
  }
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    return reject('INVALID_ROOT', sizeProfile)
  }

  let canonicalRoot: string
  try {
    canonicalRoot = await realpath(rootPath)
  } catch {
    return reject('INVALID_ROOT', sizeProfile)
  }

  let candidatePath = canonicalRoot
  for (const [index, segment] of pathSegments.entries()) {
    candidatePath = join(candidatePath, segment)
    let stats
    try {
      stats = await lstat(candidatePath)
    } catch {
      return reject('FILE_READ_FAILED', sizeProfile)
    }
    if (stats.isSymbolicLink()) return reject('SYMLINK_REJECTED', sizeProfile)
    const isFinalSegment = index === pathSegments.length - 1
    if ((!isFinalSegment && !stats.isDirectory()) || (isFinalSegment && !stats.isFile())) {
      return reject('NOT_REGULAR_FILE', sizeProfile)
    }
  }

  let canonicalCandidate: string
  try {
    canonicalCandidate = await realpath(candidatePath)
  } catch {
    return reject('FILE_READ_FAILED', sizeProfile)
  }
  if (!isPathInsideRoot(canonicalRoot, canonicalCandidate)) {
    return reject('PATH_OUTSIDE_ROOT', sizeProfile)
  }
  return canonicalCandidate
}

function sameFileSnapshot(before: BigIntStats, after: BigIntStats): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.mode === after.mode &&
    before.nlink === after.nlink &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs
  )
}

async function readOneDescriptorSnapshot(
  filePath: string,
  sizeProfile: DexStrictJsonSizeProfile
): Promise<Buffer> {
  const maximumBytes = DEX_STRICT_JSON_MAX_BYTES_BY_PROFILE[sizeProfile]
  let fileHandle: Awaited<ReturnType<typeof open>> | null = null
  try {
    fileHandle = await open(
      filePath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    )
    const before = await fileHandle.stat({ bigint: true })
    if (!before.isFile()) return reject('NOT_REGULAR_FILE', sizeProfile)
    if (before.size > BigInt(maximumBytes)) return reject('FILE_TOO_LARGE', sizeProfile)

    const storage = Buffer.allocUnsafe(maximumBytes + 1)
    let byteLength = 0
    while (byteLength < storage.byteLength) {
      const { bytesRead } = await fileHandle.read(
        storage,
        byteLength,
        storage.byteLength - byteLength,
        byteLength
      )
      if (bytesRead === 0) break
      byteLength += bytesRead
    }
    if (byteLength > maximumBytes) return reject('FILE_TOO_LARGE', sizeProfile)

    const after = await fileHandle.stat({ bigint: true })
    if (
      BigInt(byteLength) !== before.size ||
      BigInt(byteLength) !== after.size ||
      !sameFileSnapshot(before, after)
    ) {
      return reject('FILE_CHANGED_DURING_READ', sizeProfile)
    }
    return Buffer.from(storage.subarray(0, byteLength))
  } catch (error) {
    if (error instanceof DexStrictJsonDocumentError) throw error
    return reject('FILE_READ_FAILED', sizeProfile)
  } finally {
    await fileHandle?.close().catch(() => undefined)
  }
}

function startsWithBytes(bytes: Uint8Array, prefix: Uint8Array): boolean {
  return (
    bytes.byteLength >= prefix.byteLength && prefix.every((value, index) => bytes[index] === value)
  )
}

function parseSnapshot(bytes: Buffer, sizeProfile: DexStrictJsonSizeProfile): unknown {
  if (FORBIDDEN_BOMS.some((bom) => startsWithBytes(bytes, bom))) {
    return reject('BOM_REJECTED', sizeProfile)
  }

  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    return reject('INVALID_UTF8', sizeProfile)
  }

  try {
    const value = parseStrictJson(text)
    strictCanonicalJson(value)
    return value
  } catch {
    return reject('INVALID_STRICT_JSON', sizeProfile)
  }
}

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value as DeepReadonly<T>
}

function cloneStrictData<T>(value: T): T {
  const clone = deserialize(serialize(value)) as T
  const pending: unknown[] = [clone]

  while (pending.length > 0) {
    const current = pending.pop()
    if (current === null || typeof current !== 'object') continue

    if (Array.isArray(current)) {
      pending.push(...current)
      continue
    }

    Object.setPrototypeOf(current, null)
    pending.push(...Object.values(current))
  }

  return clone
}

function mintStrictJsonDocument(
  sizeProfile: DexStrictJsonSizeProfile,
  bytes: Buffer,
  value: unknown
): DexStrictJsonDocument {
  const token = Object.create(null) as object
  Object.defineProperty(token, 'toJSON', {
    value: () => {
      throw new TypeError('DEX strict JSON document token is not serializable')
    },
  })
  Object.freeze(token)
  STRICT_JSON_DOCUMENT_STATES.set(
    token,
    Object.freeze({
      declared_size_profile: sizeProfile,
      raw_sha256: createHash('sha256').update(bytes).digest('hex'),
      byte_length: bytes.byteLength,
      value: deepFreeze(value),
    })
  )
  return token as DexStrictJsonDocument
}

/**
 * Read one caller-root-contained local JSON file through a single descriptor
 * and mint a token for the exact byte snapshot that was both hashed and
 * strictly parsed.
 *
 * The caller-selected root is a containment boundary, not a trust root. This
 * caller-declared size profile only selects a code-owned byte cap; it does not
 * prove the document matches a schema or the profile's named artifact class.
 * This token does not prove provenance, artifact semantics, execution eligibility,
 * persistence eligibility, or any serving/rank/score claim. O_NOFOLLOW guards
 * the final component; the caller must still choose a non-adversarial parent
 * directory. Pre/post fstat detects ordinary concurrent mutation but is not an
 * atomic snapshot against a privileged writer.
 */
export async function readDexStrictJsonDocument(
  input: DexStrictJsonDocumentInput
): Promise<DexStrictJsonDocument> {
  const { rootPath, sizeProfile, pathSegments } = validateInput(input)
  const filePath = await resolveRegularFile(rootPath, pathSegments, sizeProfile)
  const bytes = await readOneDescriptorSnapshot(filePath, sizeProfile)
  const value = parseSnapshot(bytes, sizeProfile)
  return mintStrictJsonDocument(sizeProfile, bytes, value)
}

/**
 * Return a fresh, deeply frozen inspection copy after a WeakMap identity check.
 * The inspection is data, not a capability, and cannot be passed as a token.
 */
export function inspectDexStrictJsonDocument(document: unknown): DexStrictJsonDocumentInspection {
  const state =
    document !== null && typeof document === 'object'
      ? STRICT_JSON_DOCUMENT_STATES.get(document)
      : undefined
  if (state === undefined) {
    throw new TypeError('value is not a DEX strict JSON document token')
  }
  return Object.freeze({
    declared_size_profile: state.declared_size_profile,
    raw_sha256: state.raw_sha256,
    byte_length: state.byte_length,
    value: deepFreeze(cloneStrictData(state.value)),
  })
}
