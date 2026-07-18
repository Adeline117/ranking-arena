import { tipPostHref } from '../tip-success-links'

describe('tip success destination', () => {
  it('returns to the canonical post route', () => {
    expect(tipPostHref('post-123')).toBe('/post/post-123')
  })

  it('encodes an untrusted post id as one path segment', () => {
    expect(tipPostHref('../groups/other')).toBe('/post/..%2Fgroups%2Fother')
  })

  it('does not fabricate a post destination without an id', () => {
    expect(tipPostHref(null)).toBeNull()
    expect(tipPostHref('  ')).toBeNull()
  })
})
