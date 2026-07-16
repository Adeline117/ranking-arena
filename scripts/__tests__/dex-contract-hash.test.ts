import {
  dexContractSha256,
  strictCanonicalJson,
  strictCanonicalSha256,
} from '../lib/dex-contract-hash'

describe('strict DEX contract hashing', () => {
  it('sorts object keys by raw UTF-16 code units with a fixed hash vector', () => {
    const value = { a: 1, Z: 2 }

    expect(strictCanonicalJson(value)).toBe('{"Z":2,"a":1}')
    expect(strictCanonicalSha256(value)).toBe(
      'af48b698ce9bd15b9177108d44f2971b1f69eb5848c22c09a486b89ce97ecb9e'
    )
    expect(strictCanonicalJson({ '\u00e4': 1, z: 2, Z: 3 })).toBe('{"Z":3,"z":2,"\u00e4":1}')
    expect(strictCanonicalJson({ '\ue000': 2, '\ud83d\ude00': 1 })).toBe(
      '{"\ud83d\ude00":1,"\ue000":2}'
    )
  })

  it('serializes nested plain values and permits repeated non-cyclic references', () => {
    const shared = Object.assign(Object.create(null) as Record<string, unknown>, { b: 2, a: 1 })

    expect(strictCanonicalJson({ shared, list: [null, true, 0, 1.25, shared] })).toBe(
      '{"list":[null,true,0,1.25,{"a":1,"b":2}],"shared":{"a":1,"b":2}}'
    )
  })

  it.each([
    ['undefined', { value: undefined }],
    ['bigint', { value: 1n }],
    ['function', { value: () => true }],
    ['symbol', { value: Symbol('value') }],
    ['NaN', { value: Number.NaN }],
    ['positive infinity', { value: Number.POSITIVE_INFINITY }],
    ['negative infinity', { value: Number.NEGATIVE_INFINITY }],
    ['negative zero', { value: -0 }],
    ['date', { value: new Date(0) }],
    ['map', { value: new Map() }],
  ])('rejects %s instead of silently coercing it', (_label, value) => {
    expect(() => strictCanonicalJson(value)).toThrow('strict canonical JSON rejects')
  })

  it('rejects sparse arrays, ignored properties, symbols, and accessors', () => {
    expect(() => strictCanonicalJson(new Array(1))).toThrow('sparse arrays')

    const extra = [1] as number[] & { extra?: number }
    extra.extra = 2
    expect(() => strictCanonicalJson(extra)).toThrow('extra array properties')

    expect(() => strictCanonicalJson({ [Symbol('hidden')]: 1 })).toThrow('symbol keys')

    const accessor = Object.defineProperty({}, 'value', {
      enumerable: true,
      get: () => 1,
    })
    expect(() => strictCanonicalJson(accessor)).toThrow('object accessors')

    const hidden = Object.defineProperty({}, 'value', { enumerable: false, value: 1 })
    expect(() => strictCanonicalJson(hidden)).toThrow('non-enumerable object properties')
  })

  it('rejects cycles and isolated UTF-16 surrogates in keys or values', () => {
    const cycle: { self?: unknown } = {}
    cycle.self = cycle
    expect(() => strictCanonicalJson(cycle)).toThrow('cycles')
    const arrayCycle: unknown[] = []
    arrayCycle.push(arrayCycle)
    expect(() => strictCanonicalJson(arrayCycle)).toThrow('cycles')
    const indirectArrayCycle: unknown[] = []
    indirectArrayCycle.push({ indirectArrayCycle })
    expect(() => strictCanonicalJson(indirectArrayCycle)).toThrow('cycles')
    expect(() => strictCanonicalJson({ value: '\ud800' })).toThrow('isolated surrogate')
    expect(() => strictCanonicalJson({ ['\udc00']: 'value' })).toThrow('isolated surrogate')
    expect(strictCanonicalJson({ value: '\ud83d\ude80' })).toBe('{"value":"\ud83d\ude80"}')
  })

  it('binds payload hashes to an explicit immutable domain envelope', () => {
    const context = {
      domain: 'arena.dex.test',
      schema_id: 'arena.dex.test@1',
      schema_version: 1,
    }
    const hash = dexContractSha256(context, { value: 1 })

    expect(hash).toBe(
      strictCanonicalSha256({
        domain: 'arena.dex.test',
        payload: { value: 1 },
        schema_id: 'arena.dex.test@1',
        schema_version: 1,
      })
    )
    expect(hash).not.toBe(
      dexContractSha256({ ...context, domain: 'arena.dex.other' }, { value: 1 })
    )
    expect(hash).not.toBe(dexContractSha256({ ...context, schema_version: 2 }, { value: 1 }))
    expect(hash).not.toBe(dexContractSha256(context, { value: 2 }))
  })

  it.each([
    [{ domain: '', schema_id: 'arena.dex.test@1', schema_version: 1 }, 'domain'],
    [{ domain: ' arena.dex.test', schema_id: 'arena.dex.test@1', schema_version: 1 }, 'domain'],
    [{ domain: 'arena.dex.test', schema_id: '', schema_version: 1 }, 'schema_id'],
    [
      { domain: 'arena.dex.test', schema_id: 'arena.dex.test@1', schema_version: 0 },
      'schema_version',
    ],
    [
      { domain: 'arena.dex.test', schema_id: 'arena.dex.test@1', schema_version: 1.5 },
      'schema_version',
    ],
  ])('rejects an invalid domain envelope %j', (context, field) => {
    expect(() => dexContractSha256(context, { value: 1 })).toThrow(field)
  })

  it('rejects context metadata that would otherwise be silently omitted from the hash', () => {
    const base = {
      domain: 'arena.dex.test',
      schema_id: 'arena.dex.test@1',
      schema_version: 1,
    }
    expect(() => dexContractSha256({ ...base, chain: 'bsc' } as never, {})).toThrow(
      'exactly three schema fields'
    )
    expect(() => dexContractSha256({ ...base, [Symbol('window')]: '7d' } as never, {})).toThrow(
      'exactly three schema fields'
    )

    const hidden = Object.defineProperty({ ...base }, 'chain', {
      enumerable: false,
      value: 'bsc',
    })
    expect(() => dexContractSha256(hidden, {})).toThrow('exactly three schema fields')

    const accessor = Object.defineProperty({ ...base }, 'domain', {
      enumerable: true,
      get: () => 'arena.dex.changed',
    })
    expect(() => dexContractSha256(accessor, {})).toThrow('enumerable data properties')

    class HashContext {
      domain = base.domain
      schema_id = base.schema_id
      schema_version = base.schema_version
    }
    expect(() => dexContractSha256(new HashContext(), {})).toThrow('plain object')
  })
})
