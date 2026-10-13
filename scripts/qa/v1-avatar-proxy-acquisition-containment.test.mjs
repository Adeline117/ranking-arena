import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

function source(relativePath) {
  return readFileSync(resolve(ROOT, relativePath), 'utf8')
}

// The checks below intentionally inspect only executable source files. They do
// not scan historical documentation as evidence of a runnable acquisition path.
function codeOnly(value) {
  return value.replace(/^\s*\/\/.*$/gm, '')
}

const publication = source('lib/security/v1-avatar-proxy-publication.ts')
const route = codeOnly(source('app/api/avatar/route.ts'))
const proxy = codeOnly(source('proxy.ts'))
const avatarUtils = codeOnly(source('lib/utils/avatar.ts'))
const avatarProxy = codeOnly(source('lib/utils/avatar-proxy.ts'))
const avatarComponent = codeOnly(source('app/components/ui/Avatar.tsx'))
const leaderboardChangelog = codeOnly(source('app/components/ranking/LeaderboardChangelog.tsx'))
const traderDisplay = codeOnly(source('app/components/ranking/shared/TraderDisplay.tsx'))
const ogRoute = codeOnly(source('app/api/og/route.tsx'))
const ogTrader = codeOnly(source('app/api/og/trader/route.tsx'))
const ogExchange = codeOnly(source('app/api/og/exchange/route.tsx'))
const nextConfig = codeOnly(source('next.config.ts'))

test('V1 avatar-proxy publication is checked-in false and browser-safe', () => {
  assert.match(publication, /V1_AVATAR_PROXY_PUBLISHED\s*=\s*false\s+as const/)
  assert.match(publication, /isV1AvatarProxyPublished\(\): boolean/)
  assert.match(publication, /AVATAR_PROXY_NOT_PUBLISHED/)
  assert.doesNotMatch(publication, /process\.env|NEXT_PUBLIC_|(?:ENV|FLAG).*AVATAR_PROXY/)
})

test('public avatar compatibility route is a no-store 410 without acquisition code', () => {
  assert.match(route, /export function GET\(\): NextResponse/)
  assert.match(route, /status:\s*410/)
  for (const header of ['Cache-Control', 'CDN-Cache-Control', 'Vercel-CDN-Cache-Control']) {
    assert.match(publication, new RegExp(`['"]${header}['"]`))
  }

  for (const forbidden of [
    /\bNextRequest\b/,
    /\bnew\s+URL\b/,
    /\bsearchParams\b/,
    /\brequest\s*\./,
    /node\/dns/,
    /\b(?:dnsLookup|lookup|getCorsOrigin|logger|Buffer|allowedDomains)\b/,
    /\bfetch\s*\(/,
    /\.from\s*\(/,
  ]) {
    assert.doesNotMatch(route, forbidden)
  }
})

test('canonical and versioned avatar paths bypass proxy rate and bot guards exactly', () => {
  assert.match(
    proxy,
    /AVATAR_PROXY_BYPASS_PATHS\s*=\s*new Set\(\[['"]?[^\n]*\/api\/avatar[^\n]*\/api\/v1\/avatar/
  )
  assert.match(
    proxy,
    /isAvatarProxyBypassPath\(pathname: string\).*AVATAR_PROXY_BYPASS_PATHS\.has\(pathname\)/s
  )

  const proxyStart = proxy.indexOf('export async function proxy(request: NextRequest)')
  const handoff = proxy.indexOf('if (shouldSkip(pathname))', proxyStart)
  const ipFloor = proxy.indexOf(
    'const ipFloorBlocked = await ipFloorCheck(request, pathname)',
    proxyStart
  )
  const botGuard = proxy.indexOf("if (pathname.startsWith('/api/'))", ipFloor)
  const ipFloorStart = proxy.indexOf('async function ipFloorCheck(')
  const avatarFloorBypass = proxy.indexOf('isAvatarProxyBypassPath(pathname)', ipFloorStart)

  assert.ok(proxyStart >= 0)
  assert.ok(handoff > proxyStart)
  assert.ok(ipFloor > handoff)
  assert.ok(botGuard > ipFloor)
  assert.ok(avatarFloorBypass > ipFloorStart)
})

test('avatar helpers and direct consumers do not generate retired endpoint URLs', () => {
  for (const helper of [
    avatarUtils,
    avatarProxy,
    avatarComponent,
    leaderboardChangelog,
    traderDisplay,
  ]) {
    assert.doesNotMatch(helper, /\/api\/(?:v1\/)?avatar\?url=/)
  }

  assert.match(avatarUtils, /isV1AvatarProxyPath\(normalizedAvatarUrl\)\) return null/)
  assert.match(avatarUtils, /if \(needsProxy\(normalizedAvatarUrl\)\)\s*\{\s*return null/s)
  assert.match(avatarUtils, /if \(mirror\) return getTraderAvatarUrl\(mirror\)/)
  assert.match(avatarUtils, /if \(origin\) return getTraderAvatarUrl\(origin\)/)
  assert.match(avatarProxy, /V1_AVATAR_PROXY_FALLBACK_SRC\s*=\s*['"]data:image\/svg\+xml/)
  assert.match(
    avatarProxy,
    /isV1AvatarProxyPath\(normalizedUrl\)\) return V1_AVATAR_PROXY_FALLBACK_SRC/
  )
  assert.match(avatarComponent, /const resolved = avatarSrc\(value\)/)
  assert.doesNotMatch(avatarComponent, /\bneedsProxy\b/)
  assert.match(
    leaderboardChangelog,
    /const resolvedAvatarUrl = getTraderAvatarUrl\(mover\.avatar_url\)/
  )
  assert.doesNotMatch(leaderboardChangelog, /getTraderAvatarUrl\(mover\.avatar_url\)\s*\|\|/)
  assert.match(
    traderDisplay,
    /getTraderAvatarSrc\(\{\s*avatarMirrorUrl,\s*avatarOriginUrl: avatarUrl/s
  )
  assert.doesNotMatch(traderDisplay, /avatarMirrorUrl\?\.trim\(\)\s*\|\|/)
})

test('OG routes accept only already-inline avatars and do not create avatar fetches', () => {
  // Stricter than a bare data: prefix: only inline raster base64 images render.
  assert.match(
    ogRoute,
    /\/\^data:image\\\/\(png\|jpeg\|webp\|gif\);base64,\[A-Za-z0-9\+\/=\]\+\$\/\.test\(avatarUrlParam\)/
  )
  assert.doesNotMatch(ogRoute, /\/api\/avatar|fetch\(/)
  assert.match(ogTrader, /avatarUrl\?\.startsWith\('data:'\) \? avatarUrl : null/)
  assert.match(
    ogExchange,
    /trader\.avatar_url\?\.startsWith\('data:'\) \? trader\.avatar_url : null/
  )

  for (const ogSource of [ogRoute, ogTrader, ogExchange]) {
    assert.doesNotMatch(ogSource, /\/api\/(?:v1\/)?avatar(?:\?|['"`])/)
    assert.doesNotMatch(ogSource, /\bfetch\s*\(\s*(?:avatarUrl|avatarSrc|trader\.avatar_url)/)
  }
})

test('image optimizer no longer accepts the retired avatar API as a local image pattern', () => {
  assert.doesNotMatch(nextConfig, /pathname:\s*['"]\/api\/(?:v1\/)?avatar(?:\/\*\*)?['"]/)
})
