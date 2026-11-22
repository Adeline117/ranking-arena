/**
 * next.config.ts extends Next's default list of crawlers that must receive
 * metadata in <head> by importing it from an INTERNAL Next.js path. This test
 * exists so a Next upgrade that moves or reshapes that export fails here, with
 * an explanation, instead of as an opaque build error.
 *
 * If it fails after upgrading Next: find where HTML_LIMITED_BOT_UA_RE now lives
 * (or copy the default list into next.config.ts) and keep Googlebot in
 * `htmlLimitedBots` — without it Googlebot gets title/canonical/robots streamed
 * into <body>, which is what caused the "duplicate without canonical" pages.
 */
import { HTML_LIMITED_BOT_UA_RE } from 'next/dist/shared/lib/router/utils/html-bots'
import nextConfig from '../../../next.config'

describe('htmlLimitedBots', () => {
  it('can still import the default bot list from Next', () => {
    expect(HTML_LIMITED_BOT_UA_RE).toBeInstanceOf(RegExp)
    expect(HTML_LIMITED_BOT_UA_RE.test('Twitterbot/1.0')).toBe(true)
  })

  it('adds Googlebot while keeping the defaults', () => {
    const bots = nextConfig.htmlLimitedBots
    expect(bots).toBeInstanceOf(RegExp)
    const matches = (ua: string) => (bots as RegExp).test(ua)
    expect(
      matches('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)')
    ).toBe(true)
    expect(matches('Twitterbot/1.0')).toBe(true)
    expect(matches('Mozilla/5.0 (Macintosh) Chrome/120 Safari/537.36')).toBe(false)
  })
})
