import { safeInternalReturnPath } from '../safe-return-path'

describe('safeInternalReturnPath', () => {
  const origin = 'https://arena.example'

  it.each([
    '/',
    '/feed',
    '/search?q=btc',
    '/u/alice#activity',
    '/search?q=https%3A%2F%2Fexample.com',
  ])('keeps a same-origin application path: %s', (path) => {
    expect(safeInternalReturnPath(path, origin)).toBe(path)
  })

  it.each([
    'https://evil.example',
    '//evil.example/path',
    '/\\evil.example/path',
    '/%5cevil.example/path',
    '/%255cevil.example/path',
    '/%2f%2fevil.example/path',
    '/%252f%252fevil.example/path',
    '/%09/evil',
    '/feed\nLocation: https://evil.example',
    'feed',
    '',
  ])('rejects an external or ambiguously encoded destination: %s', (path) => {
    expect(safeInternalReturnPath(path, origin)).toBeNull()
  })
})
