import {
  getAvatarColor,
  getAvatarGradient,
  getAvatarInitial,
  getTraderAvatarSrc,
  isDirectAvatarSrc,
} from '../avatar'

describe('getTraderAvatarSrc (spec §1.4 avatar chain)', () => {
  const mirror =
    'https://iknktzifjdyujdccyhsv.supabase.co/storage/v1/object/public/trader-avatars/bitget_futures/abc.webp'
  const origin = 'https://qrc.bgstatic.com/otc/images/a.png'

  it('prefers the mirror URL directly', () => {
    expect(getTraderAvatarSrc({ avatarMirrorUrl: mirror, avatarOriginUrl: origin })).toBe(mirror)
  })

  it('proxies the origin URL when no mirror exists', () => {
    expect(getTraderAvatarSrc({ avatarMirrorUrl: null, avatarOriginUrl: origin })).toBe(
      `/api/avatar?url=${encodeURIComponent(origin)}`
    )
  })

  it('treats blank strings as missing', () => {
    expect(getTraderAvatarSrc({ avatarMirrorUrl: '  ', avatarOriginUrl: origin })).toBe(
      `/api/avatar?url=${encodeURIComponent(origin)}`
    )
  })

  it('passes data URIs and local paths through unproxied', () => {
    const dataUri = 'data:image/svg+xml,abc'
    expect(getTraderAvatarSrc({ avatarMirrorUrl: null, avatarOriginUrl: dataUri })).toBe(dataUri)
    expect(
      getTraderAvatarSrc({ avatarMirrorUrl: null, avatarOriginUrl: '/icons/exchanges/bitget.png' })
    ).toBe('/icons/exchanges/bitget.png')
  })

  it('returns null when both are missing (caller renders gradient initial)', () => {
    expect(getTraderAvatarSrc({ avatarMirrorUrl: null, avatarOriginUrl: null })).toBeNull()
    expect(
      getTraderAvatarSrc({ avatarMirrorUrl: undefined, avatarOriginUrl: undefined })
    ).toBeNull()
  })
})

describe('isDirectAvatarSrc', () => {
  it('accepts data URIs and rooted local paths (incl. pre-proxied)', () => {
    expect(isDirectAvatarSrc('data:image/svg+xml,abc')).toBe(true)
    expect(isDirectAvatarSrc('/api/avatar?url=x')).toBe(true)
    expect(isDirectAvatarSrc('/icons/exchanges/bitget.png')).toBe(true)
  })

  it('rejects exchange CDN URLs (must be proxied)', () => {
    expect(isDirectAvatarSrc('https://qrc.bgstatic.com/otc/images/a.png')).toBe(false)
  })

  it('rejects junk', () => {
    expect(isDirectAvatarSrc('not a url')).toBe(false)
  })
})

describe('getAvatarColor', () => {
  it('returns HSL color string', () => {
    const color = getAvatarColor('user-123')
    expect(color).toMatch(/^hsl\(\d+, \d+%, \d+%\)$/)
  })

  it('is deterministic', () => {
    expect(getAvatarColor('abc')).toBe(getAvatarColor('abc'))
  })

  it('different IDs give different colors', () => {
    expect(getAvatarColor('user-a')).not.toBe(getAvatarColor('user-b'))
  })
})

describe('getAvatarGradient', () => {
  it('returns gradient string', () => {
    const gradient = getAvatarGradient('user-123')
    expect(gradient).toContain('gradient')
  })

  it('is deterministic', () => {
    expect(getAvatarGradient('xyz')).toBe(getAvatarGradient('xyz'))
  })
})

describe('getAvatarInitial', () => {
  it('returns first character uppercased', () => {
    expect(getAvatarInitial('alice')).toBe('A')
  })

  it('handles null/undefined', () => {
    expect(getAvatarInitial(null)).toBeTruthy()
    expect(getAvatarInitial(undefined)).toBeTruthy()
  })

  it('handles empty string', () => {
    const result = getAvatarInitial('')
    expect(typeof result).toBe('string')
  })
})
