import fs from 'node:fs'
import path from 'node:path'
import { ALL_SOURCES } from '@/lib/constants/exchanges'
import {
  getAvatarColor,
  getAvatarGradient,
  getAvatarInitial,
  getExchangeLogoUrl,
  getTraderAvatarUrl,
  getTraderAvatarSrc,
  isDirectAvatarSrc,
} from '../avatar'
import { avatarSrc } from '../avatar-proxy'
import { canonicalizeLocalExchangeLogoPath } from '../exchange-logo-path'

describe('legacy exchange logo paths', () => {
  it.each([
    ['/icons/exchanges/binance.jpg', '/icons/exchanges/binance.png'],
    ['/icons/exchanges/mexc.jpeg', '/icons/exchanges/mexc.png'],
    ['/icons/exchanges/okx.svg', '/icons/exchanges/okx.png'],
    ['/icons/exchanges/gmx.webp', '/icons/exchanges/gmx.png'],
    ['/icons/exchanges/gateio.png', '/icons/exchanges/gate.png'],
    ['/icons/exchanges/gateio.svg?v=1#logo', '/icons/exchanges/gate.png?v=1#logo'],
  ])('canonicalizes %s', (legacy, expected) => {
    expect(canonicalizeLocalExchangeLogoPath(legacy)).toBe(expected)
  })

  it('does not rewrite remote avatars or unrelated local assets', () => {
    expect(canonicalizeLocalExchangeLogoPath('https://example.com/gateio.svg')).toBe(
      'https://example.com/gateio.svg'
    )
    expect(canonicalizeLocalExchangeLogoPath('/uploads/gateio.svg')).toBe('/uploads/gateio.svg')
  })

  it('uses only public PNG assets for exchange fallbacks', () => {
    expect(getExchangeLogoUrl('binance_futures')).toBe('/icons/exchanges/binance.png')
    expect(getExchangeLogoUrl('gateio')).toBe('/icons/exchanges/gate.png')
    expect(getExchangeLogoUrl('gtrade')).toBe('/icons/exchanges/gains.png')
  })

  it('resolves every active source to an existing public asset', () => {
    for (const source of ALL_SOURCES) {
      const logo = getExchangeLogoUrl(source)
      expect(logo).toMatch(/^\/icons\/exchanges\/[a-z0-9-]+\.png$/)
      expect(fs.existsSync(path.join(process.cwd(), 'public', logo.slice(1)))).toBe(true)
    }
  })

  it('normalizes persisted paths in all render-time resolvers', () => {
    expect(getTraderAvatarUrl('/icons/exchanges/gateio.png')).toBe('/icons/exchanges/gate.png')
    expect(
      getTraderAvatarSrc({
        avatarMirrorUrl: null,
        avatarOriginUrl: '/icons/exchanges/binance.jpg',
      })
    ).toBe('/icons/exchanges/binance.png')
    expect(avatarSrc('/icons/exchanges/mexc.jpeg')).toBe('/icons/exchanges/mexc.png')
  })
})

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
