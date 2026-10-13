import {
  isSafeProfileUrl,
  parseOptionalDiscordHandle,
  parseOptionalProfileUrl,
} from '../profile-url'

describe('profile-url', () => {
  it.each([
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'http://twitter.com/x',
    'https://localhost/x',
    'https://user:pw@twitter.com/x',
    'https://foo.internal/',
    'not a url',
    `https://x.com/${'a'.repeat(3000)}`,
  ])('rejects %s', (url) => {
    expect(isSafeProfileUrl(url)).toBe(false)
    expect(parseOptionalProfileUrl(url)).toEqual({ ok: false })
  })

  it('accepts https public URLs and trims', () => {
    expect(parseOptionalProfileUrl('  https://x.com/arena ')).toEqual({
      ok: true,
      value: 'https://x.com/arena',
    })
  })

  it('treats blank / non-string as null', () => {
    expect(parseOptionalProfileUrl('')).toEqual({ ok: true, value: null })
    expect(parseOptionalProfileUrl(null)).toEqual({ ok: true, value: null })
    expect(parseOptionalProfileUrl(123)).toEqual({ ok: true, value: null })
  })

  it('discord: allows handles and https invites, rejects other schemes', () => {
    expect(parseOptionalDiscordHandle('trader#1234')).toEqual({ ok: true, value: 'trader#1234' })
    expect(parseOptionalDiscordHandle('https://discord.gg/abc')).toEqual({
      ok: true,
      value: 'https://discord.gg/abc',
    })
    expect(parseOptionalDiscordHandle('javascript:alert(1)')).toEqual({ ok: false })
    expect(parseOptionalDiscordHandle('<img src=x>')).toEqual({ ok: false })
  })
})
