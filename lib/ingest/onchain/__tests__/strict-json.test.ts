import { parseStrictJson } from '../strict-json'

describe('parseStrictJson', () => {
  it('preserves valid JSON values', () => {
    expect(parseStrictJson('{"jsonrpc":"2.0","id":1,"result":[true,null,{"n":-1.2e3}]}')).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: [true, null, { n: -1200 }],
    })
  })

  it.each([
    '{"id":1,"id":2}',
    '{"id":1,"\\u0069d":2}',
    '{"result":{"hash":"a","hash":"b"}}',
    '[{"status":true,"status":false}]',
  ])('rejects duplicate object keys in %s', (text) => {
    expect(() => parseStrictJson(text)).toThrow('invalid strict JSON')
  })

  it.each(['', '{', '{"a":1,}', '[1,]', '01', '"unterminated', '"\\x00"', '{} trailing'])(
    'rejects malformed JSON in %j',
    (text) => {
      expect(() => parseStrictJson(text)).toThrow('invalid strict JSON')
    }
  )

  it('rejects excessive nesting without exposing the input', () => {
    const secret = 'private-api-key'
    const deeplyNested = `${'['.repeat(130)}"${secret}"${']'.repeat(130)}`
    let message = ''
    try {
      parseStrictJson(deeplyNested)
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toBe('invalid strict JSON')
    expect(message).not.toContain(secret)
  })
})
