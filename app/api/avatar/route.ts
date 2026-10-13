/**
 * 头像代理 API
 * 解决跨域和 referrer 限制问题
 */

import { NextRequest, NextResponse } from 'next/server'
import logger from '@/lib/logger'
import { getCorsOrigin } from '@/lib/utils/cors'
import { safeFetch, readBodyCapped, SafeFetchError } from '@/lib/utils/safe-fetch'
// Rate limiting removed — avatars are read-only cacheable resources with
// domain allowlist + SSRF protection. See GET handler comment for rationale.

// Avatar proxy is a read-only, cacheable operation — do NOT force-dynamic.
// Removing force-dynamic allows Vercel's CDN to cache each unique avatar URL
// so repeated requests for the same avatar hit the edge, not the serverless function.
// This is the primary fix for 429s when 20+ avatars load simultaneously on a leaderboard page.

// Pin to Tokyo — exchange CDNs are geo-blocked from US regions
export const preferredRegion = 'hnd1'

// Browser cache: 1 year immutable. Avatars are deterministic — same URL = same image forever.
// This prevents repeat requests to the serverless function for the same avatar.
const CACHE_MAX_AGE = 60 * 60 * 24 * 365

// SECURITY (audit P1-3, 2026-04-09): coerce upstream Content-Type to a
// strict image whitelist. Previously the proxy passed through whatever the
// upstream returned, including text/html or image/svg+xml with embedded
// scripts. With dangerouslyAllowSVG=true in next.config and our img-src
// CSP, an attacker who controls one of the allowed avatar sources (or who
// finds a content-injection on an exchange CDN) could ship a same-origin
// XSS payload via this proxy.
const ALLOWED_IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
])
/**
 * Decide the served Content-Type. Returns null when the payload is not a
 * verifiable raster image — such responses must NOT be cached for a year.
 * Upstream header wins when it is on the whitelist; otherwise (e.g. CDNs that
 * label avatars application/octet-stream) fall back to magic-byte sniffing.
 */
function resolveImageContentType(upstream: string | null, bytes: Uint8Array): string | null {
  const base = upstream ? upstream.split(';')[0].trim().toLowerCase() : ''
  if (ALLOWED_IMAGE_TYPES.has(base)) return base
  return sniffImageType(bytes)
}

function sniffImageType(b: Uint8Array): string | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return 'image/png'
  }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) {
    return 'image/gif'
  }
  const ascii = (from: number, to: number) => String.fromCharCode(...b.slice(from, to))
  if (b.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp'
  if (b.length >= 12 && ascii(4, 8) === 'ftyp' && /^avi[fs]$/.test(ascii(8, 12))) {
    return 'image/avif'
  }
  return null
}

// Hard cap on proxied avatar size, enforced while streaming (not only via
// Content-Length) so chunked responses cannot exhaust function memory.
const MAX_AVATAR_BYTES = 5 * 1024 * 1024

// Upstream timeout across all redirect hops + body read.
const FETCH_TIMEOUT_MS = 5_000

/** Exact hostname of THIS project's Supabase (storage avatars/covers). */
function projectSupabaseHost(): string | null {
  const raw = process.env.NEXT_PUBLIC_SUPABASE_URL
  if (!raw) return null
  try {
    return new URL(raw).hostname.toLowerCase()
  } catch {
    return null
  }
}

// 1x1 transparent PNG. Decoded once at module load.
const TRANSPARENT_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQABNjN9GQAAAABJRU5ErkJggg==',
  'base64'
)

// Upstream CDN failure handler (429 rate-limit / 5xx / timeout / network).
// Instead of passing the upstream error status through (which surfaces a broken
// <img> + console error in the browser), return a 200 transparent PNG so the
// client shows its own CSS fallback (gradient + initial). SHORT cache + SWR so
// the real avatar is retried once the upstream recovers — never cached a year
// like a successful fetch. This is the best long-term UX: no broken images, no
// surfaced 429s, self-healing.
function gracefulAvatarFallback(origin: string | null): NextResponse {
  return new NextResponse(TRANSPARENT_PNG, {
    status: 200,
    headers: {
      'Content-Type': 'image/png',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'public, max-age=300, stale-while-revalidate=3600',
      'CDN-Cache-Control': 'public, max-age=300, stale-while-revalidate=3600',
      'Access-Control-Allow-Origin': getCorsOrigin(origin),
    },
  })
}

// 允许代理的头像域名（后缀匹配）。Supabase 不在此列：只允许本项目的
// 精确 Supabase 主机（见 projectSupabaseHost），避免任意 *.supabase.co 项目被代理。
const ALLOWED_AVATAR_DOMAINS = [
  // MEXC
  'mocortech.com',
  // Bitget
  'bgstatic.com',
  // Binance (多个 CDN 域名)
  'bnbstatic.com',
  'tylhh.net',
  'nftstatic.com',
  'bscdnweb.com',
  'myqcloud.com',
  // Bybit
  'bybit.com',
  'staticimg.com',
  'bycsi.com',
  // OKX
  'okx.com',
  'okcoin.com',
  // KuCoin
  'kucoin.com',
  // Gate.io
  'gateimg.com',
  'gate.io',
  // HTX (multiple CDN domains)
  'htx.com',
  'huobi.com',
  'hbfile.net',
  'hbimg.com',
  // HTX uses specific CloudFront distributions — restrict to avoid open proxy
  'd2uuskl05wy6ml.cloudfront.net',
  'd1nhio0ox7pgb.cloudfront.net',
  'd1x7dwosqaosdj.cloudfront.net',
  // BingX
  'bingx.com',
  // CoinEx
  'coinex.com',
  'coinexstatic.com', // file.coinexstatic.com — CoinEx avatar CDN
  // LBank
  'lbkrs.com',
  'lbank.com',
  // Phemex
  'phemex.com',
  // Bitmart
  'bitmart.com',
  // XT
  'xt.com',
  'static-global.com',
  // Pionex
  'pionex.com',
  // Weex
  'weex.com',
  'wexx.one',
  // Blofin
  'blofin.com',
  // BingX CDN
  'bb-os.com',
  // BTCC
  'btuserlog.com',
  // GMX
  'gmx.io',
  // Bitfinex
  'bitfinex.com',
  // BTSE
  'btse.com',
  // dYdX
  'dydx.exchange',
  // WhiteBit
  'whitebit.com',
  // Toobit
  'toobit.com',
  // eToro
  'etorostatic.com',
  'etoro.com',
  // Bitunix (img.bitunix.com serves bitunix trader avatars — actively served source)
  'bitunix.com',
  // Aevo
  'aevo.xyz',
  // Hyperliquid
  'hyperliquid.xyz',
  // Jupiter
  'jup.ag',
  // Gate.io / Gate CFD avatar CDNs (enumerated from arena.* serving rows,
  // 2026-06-11) — gavatar.staticimgs.com + img.gatenft.io serve gate avatars.
  'staticimgs.com',
  'gatenft.io',
  // OKX legacy avatar CDN (static.coinall.ltd)
  'coinall.ltd',
  // Long-tail serving-source avatar CDNs (enumerated from arena.traders,
  // 2026-06-11). Each backs ≥1 active serving source's trader avatars.
  'snidefender.com', // api-img.snidefender.com
  'p2primeglobal.com', // public.p2primeglobal.com
  'hotfullmoon.com', // nft.hotfullmoon.com
  'saasexch.com', // public.saasexch.com
  'cbearq.cn', // public.s.cbearq.cn
  'dm1mubcttd115.cloudfront.net', // pinned exact subdomain (avoid open proxy)
  // Our CDN
  'arenafi.org',
  // GitHub
  'githubusercontent.com',
  // Google
  'googleusercontent.com',
  'google.com',
  // Avatar generators (for seed/community avatars)
  'dicebear.com',
  'pravatar.cc',
  'robohash.org',
  'randomuser.me',
  'ui-avatars.com',
]

function isAllowedAvatarUrl(url: URL): boolean {
  const host = url.hostname.toLowerCase()
  const supabaseHost = projectSupabaseHost()
  if (supabaseHost && host === supabaseHost) return true
  // Strict suffix match: hostname must equal or be a subdomain of an allowed domain.
  // e.g. "cdn.bnbstatic.com" matches "bnbstatic.com", but "evil-bnbstatic.com" does not.
  return ALLOWED_AVATAR_DOMAINS.some((domain) => host === domain || host.endsWith('.' + domain))
}

export async function GET(request: NextRequest) {
  // NO rate limiting on avatar proxy. Rationale:
  // - Read-only, idempotent image proxy — no mutation, no abuse vector
  // - Already protected by: domain allowlist, SSRF check, 5s timeout
  // - CDN caches responses for 1 year (immutable) — repeat requests never hit origin
  // - Homepage loads 50 avatars simultaneously; any rate limit < 600 causes 429s
  // - The `read` bucket was shared with /api/traders, causing cascading 429s
  //   when both avatar + trader requests competed for the same 600/min budget

  const { searchParams } = new URL(request.url)
  const url = searchParams.get('url')

  if (!url) {
    return new NextResponse('Missing url parameter', { status: 400 })
  }
  const origin = request.headers.get('Origin')

  try {
    // 解码 URL
    let decodedUrl: string
    try {
      decodedUrl = decodeURIComponent(url)
    } catch {
      return new NextResponse('Invalid URL encoding', { status: 400 })
    }

    // Data URIs should never be proxied — return 1x1 transparent PNG so the
    // browser shows the CSS fallback (gradient + initial) without 400 errors.
    if (decodedUrl.startsWith('data:')) {
      return new NextResponse(TRANSPARENT_PNG, {
        status: 200,
        headers: {
          'Content-Type': 'image/png',
          'Cache-Control': `public, max-age=${CACHE_MAX_AGE}, immutable`,
        },
      })
    }

    // Reject non-HTTP(S) URLs
    if (!decodedUrl.startsWith('http://') && !decodedUrl.startsWith('https://')) {
      return new NextResponse('Only HTTP(S) URLs allowed', { status: 400 })
    }

    let urlObj: URL
    try {
      urlObj = new URL(decodedUrl)
    } catch {
      return new NextResponse('Invalid URL', { status: 400 })
    }

    if (!isAllowedAvatarUrl(urlObj)) {
      // Allowlist gap (e.g. a serving source's avatar CDN not yet enumerated, like
      // img.meimaobing.top backing some Bitunix traders). Returning a 403 here
      // surfaces a console error + broken <img>. Degrade gracefully to a 200
      // transparent PNG (short cache) so the client shows its CSS fallback and no
      // error is logged — the same treatment given to upstream 401/403/5xx below.
      return gracefulAvatarFallback(origin)
    }

    // SSRF defense (safeFetch): redirects are followed manually (max 3 hops) and
    // every hop is re-checked against the allowlist AND resolved via DNS with
    // private/reserved IPs rejected. One timeout spans all hops + body read.
    const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS)
    const browserHeaders = (u: URL): RequestInit => ({
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Referer: u.origin + '/',
        Origin: u.origin,
        Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7',
        'Sec-Fetch-Dest': 'image',
        'Sec-Fetch-Mode': 'no-cors',
        'Sec-Fetch-Site': 'cross-site',
      },
    })
    // Retry with minimal headers — some CDNs block specific header combos
    const minimalHeaders = (): RequestInit => ({
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        Accept: 'image/*,*/*;q=0.8',
      },
    })

    let { response } = await safeFetch(urlObj.href, {
      isAllowed: isAllowedAvatarUrl,
      init: browserHeaders,
      signal,
    })

    if (!response.ok && [401, 403, 502, 503].includes(response.status)) {
      try {
        await response.body?.cancel()
      } catch {
        /* already closed */
      }
      ;({ response } = await safeFetch(urlObj.href, {
        isAllowed: isAllowedAvatarUrl,
        init: minimalHeaders,
        signal,
      }))
    }

    if (!response.ok) {
      try {
        await response.body?.cancel()
      } catch {
        /* already closed */
      }
      // Upstream rate-limited (429) or errored — serve graceful fallback, not
      // a broken image. Short cache so we retry once upstream recovers.
      return gracefulAvatarFallback(origin)
    }

    const body = await readBodyCapped(response, MAX_AVATAR_BYTES)
    const contentType = resolveImageContentType(response.headers.get('content-type'), body)
    if (!contentType) {
      // Not a verifiable raster image (HTML error page, SVG, JSON…). Never
      // serve it, and never let it be cached for a year.
      return gracefulAvatarFallback(origin)
    }

    return new NextResponse(body, {
      headers: {
        'Content-Type': contentType,
        'X-Content-Type-Options': 'nosniff',
        // 1-year immutable cache — avatars for a given seed/URL never change.
        'Cache-Control': `public, max-age=${CACHE_MAX_AGE}, immutable`,
        'Surrogate-Control': `max-age=${CACHE_MAX_AGE}`,
        'CDN-Cache-Control': `public, max-age=${CACHE_MAX_AGE}, immutable`,
        'Access-Control-Allow-Origin': getCorsOrigin(origin),
      },
    })
  } catch (error: unknown) {
    if (error instanceof SafeFetchError) {
      if (error.code === 'blocked' || error.code === 'too_large') {
        logger.warn('Avatar proxy rejected upstream', { code: error.code, reason: error.message })
      }
      // Blocked hop / private IP / oversize / redirect loop — degrade to the
      // short-cached transparent PNG (never the 1-year immutable cache).
      return gracefulAvatarFallback(origin)
    }
    // Distinguish upstream/network failures from true server errors so they
    // don't pollute 500 error dashboards.
    if (error instanceof Error) {
      if (error.name === 'AbortError' || error.name === 'TimeoutError') {
        // Upstream CDN timed out — serve graceful fallback (short cache, retry later)
        return gracefulAvatarFallback(origin)
      }
      const msg = error.message.toLowerCase()
      if (
        msg.includes('econnrefused') ||
        msg.includes('enotfound') ||
        msg.includes('econnreset') ||
        msg.includes('network') ||
        msg.includes('fetch failed')
      ) {
        // Upstream network error — serve graceful fallback (short cache, retry later)
        return gracefulAvatarFallback(origin)
      }
    }
    logger.error('Avatar proxy error:', error)
    return new NextResponse('Internal error', { status: 500 })
  }
}
