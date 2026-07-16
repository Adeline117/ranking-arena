import { createHash } from 'node:crypto'

export interface DexContractHashContext {
  domain: string
  schema_id: string
  schema_version: number
}

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

function parseContext(context: DexContractHashContext): DexContractHashContext {
  if (!context || typeof context !== 'object' || Array.isArray(context)) {
    throw new TypeError('DEX contract hash context must be an object')
  }
  const prototype = Object.getPrototypeOf(context)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('DEX contract hash context must be a plain object')
  }
  const expectedKeys = ['domain', 'schema_id', 'schema_version']
  const ownKeys = Reflect.ownKeys(context)
  if (
    ownKeys.length !== expectedKeys.length ||
    ownKeys.some((key) => typeof key !== 'string' || !expectedKeys.includes(key))
  ) {
    throw new TypeError('DEX contract hash context must contain exactly three schema fields')
  }
  const contextValues = Object.fromEntries(
    expectedKeys.map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(context, key)
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
        throw new TypeError('DEX contract hash context fields must be enumerable data properties')
      }
      return [key, descriptor.value]
    })
  )
  const domain = contextValues.domain
  const schemaId = contextValues.schema_id
  const schemaVersion = contextValues.schema_version
  if (typeof domain !== 'string' || domain.length === 0 || domain.trim() !== domain) {
    throw new TypeError('DEX contract hash domain must be a non-empty trimmed string')
  }
  if (typeof schemaId !== 'string' || schemaId.length === 0 || schemaId.trim() !== schemaId) {
    throw new TypeError('DEX contract hash schema_id must be a non-empty trimmed string')
  }
  assertUnicodeScalarString(domain, 'hash domain')
  assertUnicodeScalarString(schemaId, 'hash schema_id')
  if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 1) {
    throw new TypeError('DEX contract hash schema_version must be a positive safe integer')
  }
  return { domain, schema_id: schemaId, schema_version: schemaVersion }
}

/** Hash a payload only after binding it to an explicit domain and schema. */
export function dexContractSha256(context: DexContractHashContext, payload: unknown): string {
  const parsed = parseContext(context)
  return strictCanonicalSha256({ ...parsed, payload })
}
