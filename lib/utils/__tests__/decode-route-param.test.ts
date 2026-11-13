import { decodeRouteParam } from '../decode-route-param'

describe('decodeRouteParam', () => {
  it('decodes an encoded segment', () => {
    expect(decodeRouteParam('alice%20bob')).toBe('alice bob')
  })

  it('returns an already-decoded handle containing a bare % unchanged instead of throwing', () => {
    expect(() => decodeURIComponent('100%Win')).toThrow(URIError)
    expect(decodeRouteParam('100%Win')).toBe('100%Win')
  })
})
