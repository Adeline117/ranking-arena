import {
  STRICT_CANONICAL_JSON_CONTRACT,
  strictCanonicalJson,
  strictCanonicalSha256,
} from '../../lib/ingest/strict-canonical-json'

export { STRICT_CANONICAL_JSON_CONTRACT, strictCanonicalJson, strictCanonicalSha256 }

export interface DexContractHashContext {
  domain: string
  schema_id: string
  schema_version: number
}

function assertUnicodeScalarString(value: string, label: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index)
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new TypeError(`strict canonical JSON rejects isolated surrogate in ${label}`)
      }
      index += 1
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new TypeError(`strict canonical JSON rejects isolated surrogate in ${label}`)
    }
  }
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
