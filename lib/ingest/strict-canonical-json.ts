import { createHash, type Hash } from 'node:crypto'
import { isProxy } from 'node:util/types'

export const STRICT_CANONICAL_JSON_CONTRACT = 'arena.strict-canonical-json@1'

const STRING_CHUNK_CODE_UNITS = 64 * 1024
const BYTE_LIMIT_EXCEEDED = Symbol('strict canonical JSON byte limit exceeded')

interface CanonicalTokenSink {
  write(token: string): void
  assertCapacityFor?(minimumAdditionalUtf8Bytes: number): void
}

export type StrictCanonicalJsonDigestWithinLimit =
  | Readonly<{
      withinLimit: true
      utf8ByteLength: number
      sha256: string
    }>
  | Readonly<{
      withinLimit: false
    }>

function reject(reason: string): never {
  throw new TypeError(`strict canonical JSON rejects ${reason}`)
}

function compareUtf16CodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function controlEscape(codeUnit: number): string | null {
  switch (codeUnit) {
    case 0x08:
      return '\\b'
    case 0x09:
      return '\\t'
    case 0x0a:
      return '\\n'
    case 0x0c:
      return '\\f'
    case 0x0d:
      return '\\r'
    default:
      return codeUnit <= 0x1f ? `\\u00${codeUnit.toString(16).padStart(2, '0')}` : null
  }
}

/** Emit the exact JSON string representation without allocating one escaped copy. */
function emitQuotedString(value: string, label: string, sink: CanonicalTokenSink): void {
  sink.write('"')
  let spanStart = 0
  let index = 0

  while (index < value.length) {
    const codeUnit = value.charCodeAt(index)
    let width = 1
    let escape: string | null = null

    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) reject(`isolated surrogate in ${label}`)
      width = 2
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      reject(`isolated surrogate in ${label}`)
    } else if (codeUnit === 0x22) {
      escape = '\\"'
    } else if (codeUnit === 0x5c) {
      escape = '\\\\'
    } else {
      escape = controlEscape(codeUnit)
    }

    if (escape !== null) {
      if (spanStart < index) sink.write(value.slice(spanStart, index))
      sink.write(escape)
      index += width
      spanStart = index
      continue
    }

    index += width
    if (index - spanStart >= STRING_CHUNK_CODE_UNITS) {
      // `index` is always a Unicode-scalar boundary, so one hash update never
      // splits a surrogate pair into two replacement characters.
      sink.write(value.slice(spanStart, index))
      spanStart = index
    }
  }

  if (spanStart < value.length) sink.write(value.slice(spanStart))
  sink.write('"')
}

function walkCanonicalArray(
  value: unknown[],
  ancestors: Set<object>,
  sink: CanonicalTokenSink
): void {
  const minimumCanonicalBytes = value.length === 0 ? 2 : value.length * 2 + 1
  sink.assertCapacityFor?.(minimumCanonicalBytes)
  const ownKeys = Reflect.ownKeys(value)
  const allowedKeys = new Set<PropertyKey>(['length'])
  sink.write('[')

  for (let index = 0; index < value.length; index += 1) {
    if (index > 0) sink.write(',')
    const key = String(index)
    allowedKeys.add(key)
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor) reject('sparse arrays')
    if (!('value' in descriptor)) reject('array accessors')
    walkCanonicalValue(descriptor.value, ancestors, sink)
  }

  if (ownKeys.some((key) => !allowedKeys.has(key))) reject('extra array properties')
  sink.write(']')
}

function walkCanonicalObject(
  value: object,
  ancestors: Set<object>,
  sink: CanonicalTokenSink
): void {
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) reject('non-plain objects')

  const ownKeys = Reflect.ownKeys(value)
  if (ownKeys.some((key) => typeof key === 'symbol')) reject('symbol keys')
  const keys = (ownKeys as string[]).sort(compareUtf16CodeUnits)
  sink.write('{')

  keys.forEach((key, index) => {
    if (index > 0) sink.write(',')
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !descriptor.enumerable) reject('non-enumerable object properties')
    if (!('value' in descriptor)) reject('object accessors')
    emitQuotedString(key, 'object key', sink)
    sink.write(':')
    walkCanonicalValue(descriptor.value, ancestors, sink)
  })
  sink.write('}')
}

function walkCanonicalValue(
  value: unknown,
  ancestors: Set<object>,
  sink: CanonicalTokenSink
): void {
  if (value === null) {
    sink.write('null')
    return
  }
  if (typeof value === 'boolean') {
    sink.write(value ? 'true' : 'false')
    return
  }
  if (typeof value === 'string') {
    emitQuotedString(value, 'string value', sink)
    return
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) reject('non-finite numbers')
    if (Object.is(value, -0)) reject('negative zero')
    const serialized = JSON.stringify(value)
    if (typeof serialized !== 'string') reject('number serialization')
    sink.write(serialized)
    return
  }
  if (typeof value !== 'object') reject(typeof value)
  if (isProxy(value)) reject('proxy objects')
  if (ancestors.has(value)) reject('cycles')

  ancestors.add(value)
  try {
    if (Array.isArray(value)) walkCanonicalArray(value, ancestors, sink)
    else walkCanonicalObject(value, ancestors, sink)
  } finally {
    ancestors.delete(value)
  }
}

function digestSink(
  maxUtf8Bytes: number,
  hash: Hash
): {
  sink: CanonicalTokenSink
  byteLength: () => number
} {
  let utf8ByteLength = 0
  return {
    sink: {
      assertCapacityFor(minimumAdditionalUtf8Bytes) {
        if (minimumAdditionalUtf8Bytes > maxUtf8Bytes - utf8ByteLength) {
          throw BYTE_LIMIT_EXCEEDED
        }
      },
      write(token) {
        const tokenBytes = Buffer.byteLength(token, 'utf8')
        if (tokenBytes > maxUtf8Bytes - utf8ByteLength) throw BYTE_LIMIT_EXCEEDED
        utf8ByteLength += tokenBytes
        hash.update(token, 'utf8')
      },
    },
    byteLength: () => utf8ByteLength,
  }
}

function collectingSink(): {
  sink: CanonicalTokenSink
  json: () => string
} {
  const chunks: string[] = []
  let pendingTokens: string[] = []
  let pendingCodeUnits = 0

  function flush(): void {
    if (pendingTokens.length === 0) return
    chunks.push(pendingTokens.join(''))
    pendingTokens = []
    pendingCodeUnits = 0
  }

  return {
    sink: {
      write(token) {
        if (token.length === 0) return
        pendingTokens.push(token)
        pendingCodeUnits += token.length
        if (pendingCodeUnits >= STRING_CHUNK_CODE_UNITS) flush()
      },
    },
    json: () => {
      flush()
      return chunks.join('')
    },
  }
}

/**
 * Validate, count, and hash the strict-canonical UTF-8 token stream without
 * first materializing the complete JSON string. Oversized inputs fail closed
 * as soon as the emitted prefix crosses the caller's bound.
 */
export function strictCanonicalJsonDigestWithinLimit(
  value: unknown,
  maxUtf8Bytes: number
): StrictCanonicalJsonDigestWithinLimit {
  if (!Number.isSafeInteger(maxUtf8Bytes) || maxUtf8Bytes < 0) {
    throw new RangeError('strict canonical JSON byte limit must be a nonnegative safe integer')
  }

  const hash = createHash('sha256')
  const bounded = digestSink(maxUtf8Bytes, hash)
  try {
    walkCanonicalValue(value, new Set(), bounded.sink)
  } catch (cause) {
    if (cause === BYTE_LIMIT_EXCEEDED) return { withinLimit: false }
    throw cause
  }
  return {
    withinLimit: true,
    utf8ByteLength: bounded.byteLength(),
    sha256: hash.digest('hex'),
  }
}

/**
 * Serialize a strict JSON value with object keys ordered by raw UTF-16 code
 * units. This deliberately avoids locale-sensitive comparison and rejects
 * values that JSON.stringify would silently omit or coerce.
 */
export function strictCanonicalJson(value: unknown): string {
  const collector = collectingSink()
  walkCanonicalValue(value, new Set(), collector.sink)
  return collector.json()
}

export function strictCanonicalSha256(value: unknown): string {
  const digest = strictCanonicalJsonDigestWithinLimit(value, Number.MAX_SAFE_INTEGER)
  if (!digest.withinLimit) reject('canonical UTF-8 length above the safe-integer range')
  return digest.sha256
}
