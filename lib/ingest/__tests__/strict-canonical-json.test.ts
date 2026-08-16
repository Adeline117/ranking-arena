import { createHash } from 'node:crypto'

import {
  STRICT_CANONICAL_JSON_CONTRACT,
  strictCanonicalJsonDigestWithinLimit,
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

  it('counts and hashes the exact canonical UTF-8 stream at its byte boundary', () => {
    const values: unknown[] = [
      null,
      true,
      false,
      0,
      1e21,
      1e-7,
      Number.MAX_VALUE,
      Number.MIN_VALUE,
      '',
      '\b\t\n\f\r\u0000"\\',
      '\u007f\u07ff\u0800\u2028\u2029',
      '\ud800\udc00\udbff\udfff',
      `${'a'.repeat(65_535)}\ud83d\ude00${'b'.repeat(65_536)}`,
      [0, 'value', null],
      { a: ['\ud83d\ude00'], Z: { value: true } },
    ]

    for (const value of values) {
      const canonical = strictCanonicalJson(value)
      const utf8ByteLength = Buffer.byteLength(canonical, 'utf8')
      const sha256 = createHash('sha256').update(canonical, 'utf8').digest('hex')

      expect(strictCanonicalJsonDigestWithinLimit(value, utf8ByteLength)).toEqual({
        withinLimit: true,
        utf8ByteLength,
        sha256,
      })
      expect(strictCanonicalJsonDigestWithinLimit(value, utf8ByteLength - 1)).toEqual({
        withinLimit: false,
      })
      expect(strictCanonicalSha256(value)).toBe(sha256)
    }
  })

  it('matches JSON string escaping across every non-surrogate BMP scalar and astral edges', () => {
    const bmpScalars: string[] = []
    for (let codeUnit = 0; codeUnit <= 0xffff; codeUnit += 1) {
      if (codeUnit < 0xd800 || codeUnit > 0xdfff) {
        bmpScalars.push(String.fromCharCode(codeUnit))
      }
    }
    const value = `${bmpScalars.join('')}\u{10000}\u{10ffff}`
    const expected = JSON.stringify(value)

    expect(strictCanonicalJson(value)).toBe(expected)
    expect(
      strictCanonicalJsonDigestWithinLimit(value, Buffer.byteLength(expected, 'utf8'))
    ).toEqual({
      withinLimit: true,
      utf8ByteLength: Buffer.byteLength(expected, 'utf8'),
      sha256: createHash('sha256').update(expected, 'utf8').digest('hex'),
    })
  })

  it('bounds a large string without constructing one escaped JSON copy', () => {
    const value = 'a'.repeat(1024 * 1024)
    const stringify = jest.spyOn(JSON, 'stringify')
    try {
      expect(strictCanonicalJsonDigestWithinLimit(value, 8)).toEqual({ withinLimit: false })
      expect(stringify).not.toHaveBeenCalled()
    } finally {
      stringify.mockRestore()
    }
  })

  it('rejects an array whose minimum JSON form exceeds the remaining bound before enumeration', () => {
    const oversizedByMinimum = new Array(134_217_728)
    const ownKeys = jest.spyOn(Reflect, 'ownKeys')
    let result: ReturnType<typeof strictCanonicalJsonDigestWithinLimit> | undefined
    let ownKeyCalls = -1
    try {
      result = strictCanonicalJsonDigestWithinLimit(oversizedByMinimum, 256 * 1024 * 1024)
      ownKeyCalls = ownKeys.mock.calls.length
    } finally {
      ownKeys.mockRestore()
    }

    expect(result).toEqual({ withinLimit: false })
    expect(ownKeyCalls).toBe(0)
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

  it('preserves strict object and array rules in the bounded digest path', () => {
    const sparse = new Array(1)
    expect(() => strictCanonicalJsonDigestWithinLimit(sparse, 1024)).toThrow('sparse arrays')

    const extra = [1]
    Object.defineProperty(extra, 'extra', { enumerable: true, value: 2 })
    expect(() => strictCanonicalJsonDigestWithinLimit(extra, 1024)).toThrow(
      'extra array properties'
    )

    let arrayAccessorReads = 0
    const accessorArray = [1]
    Object.defineProperty(accessorArray, '0', {
      enumerable: true,
      get() {
        arrayAccessorReads += 1
        return 1
      },
    })
    expect(() => strictCanonicalJsonDigestWithinLimit(accessorArray, 1024)).toThrow(
      'array accessors'
    )
    expect(arrayAccessorReads).toBe(0)

    const hidden = Object.defineProperty({}, 'hidden', { enumerable: false, value: true })
    expect(() => strictCanonicalJsonDigestWithinLimit(hidden, 1024)).toThrow(
      'non-enumerable object properties'
    )
    expect(() => strictCanonicalJsonDigestWithinLimit({ [Symbol('hidden')]: true }, 1024)).toThrow(
      'symbol keys'
    )
  })

  it('validates the byte bound before inspecting evidence', () => {
    let trapCalls = 0
    const proxy = new Proxy(
      {},
      {
        getPrototypeOf() {
          trapCalls += 1
          throw new Error('must not inspect a proxy')
        },
      }
    )

    for (const limit of [-1, 1.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => strictCanonicalJsonDigestWithinLimit(proxy, limit)).toThrow(
        'byte limit must be a nonnegative safe integer'
      )
    }
    expect(trapCalls).toBe(0)
  })

  it('rejects proxy objects before invoking any proxy trap', () => {
    let trapCalls = 0
    const proxy = new Proxy(
      { value: 1 },
      {
        getPrototypeOf() {
          trapCalls += 1
          throw new Error('must not inspect a proxy')
        },
        ownKeys() {
          trapCalls += 1
          throw new Error('must not inspect a proxy')
        },
        getOwnPropertyDescriptor() {
          trapCalls += 1
          throw new Error('must not inspect a proxy')
        },
      }
    )

    expect(() => strictCanonicalJson(proxy)).toThrow('proxy objects')
    expect(() => strictCanonicalJson({ nested: proxy })).toThrow('proxy objects')
    expect(() => strictCanonicalJson(new Proxy([1], {}))).toThrow('proxy objects')
    expect(() => strictCanonicalJsonDigestWithinLimit(proxy, 1024)).toThrow('proxy objects')
    expect(() => strictCanonicalJsonDigestWithinLimit({ nested: proxy }, 1024)).toThrow(
      'proxy objects'
    )
    expect(trapCalls).toBe(0)
  })

  it('never invokes object accessors while producing a bounded digest', () => {
    let reads = 0
    const accessor = Object.defineProperty({}, 'value', {
      enumerable: true,
      get() {
        reads += 1
        return 'secret'
      },
    })

    expect(() => strictCanonicalJsonDigestWithinLimit(accessor, 1024)).toThrow('object accessors')
    expect(reads).toBe(0)
  })
})
