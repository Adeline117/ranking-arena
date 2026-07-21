import {
  STRICT_CANONICAL_JSON_CONTRACT,
  strictCanonicalJson,
  strictCanonicalSha256,
} from '@/lib/ingest/strict-canonical-json'

describe('strict canonical JSON', () => {
  it('preserves the fixed UTF-16 ordering and SHA-256 vector', () => {
    const value = { a: 1, Z: 2 }

    expect(STRICT_CANONICAL_JSON_CONTRACT).toBe('arena.strict-canonical-json@1')
    expect(strictCanonicalJson(value)).toBe('{"Z":2,"a":1}')
    expect(strictCanonicalSha256(value)).toBe(
      'af48b698ce9bd15b9177108d44f2971b1f69eb5848c22c09a486b89ce97ecb9e'
    )
    expect(strictCanonicalJson({ '\ue000': 2, '\ud83d\ude00': 1 })).toBe(
      '{"\ud83d\ude00":1,"\ue000":2}'
    )
  })

  it.each([
    ['undefined', { value: undefined }],
    ['non-finite number', { value: Number.NaN }],
    ['negative zero', { value: -0 }],
    ['non-plain object', { value: new Date(0) }],
  ])('rejects %s instead of accepting a lossy JSON representation', (_label, value) => {
    expect(() => strictCanonicalJson(value)).toThrow('strict canonical JSON rejects')
  })

  it('rejects structural ambiguity, cycles, and invalid Unicode', () => {
    expect(() => strictCanonicalJson(new Array(1))).toThrow('sparse arrays')

    const accessor = Object.defineProperty({}, 'value', {
      enumerable: true,
      get: () => 1,
    })
    expect(() => strictCanonicalJson(accessor)).toThrow('object accessors')

    const cycle: { self?: unknown } = {}
    cycle.self = cycle
    expect(() => strictCanonicalJson(cycle)).toThrow('cycles')
    expect(() => strictCanonicalJson({ value: '\ud800' })).toThrow('isolated surrogate')
  })
})
