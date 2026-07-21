import { createHash } from 'node:crypto'

export const STRICT_CANONICAL_JSON_CONTRACT = 'arena.strict-canonical-json@1'

function reject(reason: string): never {
  throw new TypeError(`strict canonical JSON rejects ${reason}`)
}

function assertUnicodeScalarString(value: string, label: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index)
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) reject(`isolated surrogate in ${label}`)
      index += 1
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      reject(`isolated surrogate in ${label}`)
    }
  }
}

function compareUtf16CodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function canonicalArray(value: unknown[], ancestors: Set<object>): string {
  const ownKeys = Reflect.ownKeys(value)
  const allowedKeys = new Set<PropertyKey>(['length'])
  const items: string[] = []

  for (let index = 0; index < value.length; index += 1) {
    const key = String(index)
    allowedKeys.add(key)
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor) reject('sparse arrays')
    if (!('value' in descriptor)) reject('array accessors')
    items.push(canonicalValue(descriptor.value, ancestors))
  }

  if (ownKeys.some((key) => !allowedKeys.has(key))) reject('extra array properties')
  return `[${items.join(',')}]`
}

function canonicalObject(value: object, ancestors: Set<object>): string {
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) reject('non-plain objects')

  const ownKeys = Reflect.ownKeys(value)
  if (ownKeys.some((key) => typeof key === 'symbol')) reject('symbol keys')
  const keys = (ownKeys as string[]).sort(compareUtf16CodeUnits)

  const entries = keys.map((key) => {
    assertUnicodeScalarString(key, 'object key')
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !descriptor.enumerable) reject('non-enumerable object properties')
    if (!('value' in descriptor)) reject('object accessors')
    return `${JSON.stringify(key)}:${canonicalValue(descriptor.value, ancestors)}`
  })
  return `{${entries.join(',')}}`
}

function canonicalValue(value: unknown, ancestors: Set<object>): string {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'string') {
    assertUnicodeScalarString(value, 'string value')
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) reject('non-finite numbers')
    if (Object.is(value, -0)) reject('negative zero')
    return JSON.stringify(value)
  }
  if (typeof value !== 'object') reject(typeof value)
  if (ancestors.has(value)) reject('cycles')

  ancestors.add(value)
  try {
    return Array.isArray(value)
      ? canonicalArray(value, ancestors)
      : canonicalObject(value, ancestors)
  } finally {
    ancestors.delete(value)
  }
}

/**
 * Serialize a strict JSON value with object keys ordered by raw UTF-16 code
 * units. This deliberately avoids locale-sensitive comparison and rejects
 * values that JSON.stringify would silently omit or coerce.
 */
export function strictCanonicalJson(value: unknown): string {
  return canonicalValue(value, new Set())
}

export function strictCanonicalSha256(value: unknown): string {
  return createHash('sha256').update(strictCanonicalJson(value), 'utf8').digest('hex')
}
