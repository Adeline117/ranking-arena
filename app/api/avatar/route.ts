/**
 * 头像代理 API
 * 解决跨域和 referrer 限制问题
 */

import { NextRequest, NextResponse } from 'next/server'
import logger from '@/lib/logger'
import { getCorsOrigin } from '@/lib/utils/cors'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'

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
  'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif',
])
function safeImageContentType(upstream: string | null): string {
  if (!upstream) return 'image/png'
  const base = upstream.split(';')[0].trim().toLowerCase()
  return ALLOWED_IMAGE_TYPES.has(base) ? base : 'image/png'
}

export async function GET(request: NextRequest) {
  // Rate limit: 60 req/min per IP (avatar proxy is public but must not be abused)
  const rateLimitResp = await checkRateLimit(request, RateLimitPresets.search)
  if (rateLimitResp) return rateLimitResp

  const { searchParams } = new URL(request.url)
  const url = searchParams.get('url')

  if (!url) {
    return new NextResponse('Missing url parameter', { status: 400 })
  }

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
      const transparentPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQABNjN9GQAAAABJRU5ErkJggg==', 'base64')
      return new NextResponse(transparentPng, {
        status: 200,
        headers: { 'Content-Type': 'image/png', 'Cache-Control': `public, max-age=${CACHE_MAX_AGE}, immutable` },
      })
    }

    // Reject non-HTTP(S) URLs
    if (!decodedUrl.startsWith('http://') && !decodedUrl.startsWith('https://')) {
      return new NextResponse('Only HTTP(S) URLs allowed', { status: 400 })
    }

    // 验证 URL 是否来自允许的域名
    const allowedDomains = [
      // Supabase Storage (user uploaded avatars/covers)
      'supabase.co',
      'supabase.in',
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
      // BingX
      'bingx.com',
      // CoinEx
      'coinex.com',
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
      // Aevo
      'aevo.xyz',
      // Hyperliquid
      'hyperliquid.xyz',
      // Jupiter
      'jup.ag',
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
    
    const urlObj = new URL(decodedUrl)
    // Strict suffix match: hostname must equal or be a subdomain of an allowed domain.
    // e.g. "cdn.bnbstatic.com" matches "bnbstatic.com", but "evil-bnbstatic.com" does not.
    const isAllowed = allowedDomains.some(
      domain => urlObj.hostname === domain || urlObj.hostname.endsWith('.' + domain)
    )
    
    if (!isAllowed) {
      return new NextResponse('Domain not allowed', { status: 403 })
    }

    // 请求图片 - 模拟浏览器请求（5s timeout 防止 function 挂起 + SSRF mitigation）
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5_000)

    const response = await fetch(decodedUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': urlObj.origin + '/',
        'Origin': urlObj.origin,
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7',
        'Sec-Fetch-Dest': 'image',
        'Sec-Fetch-Mode': 'no-cors',
        'Sec-Fetch-Site': 'cross-site',
      },
    }).finally(() => clearTimeout(timeout))

    if (!response.ok && (response.status === 403 || response.status === 401 || response.status === 502 || response.status === 503)) {
      // Retry with minimal headers — some CDNs block specific header combos
      const controller2 = new AbortController()
      const timeout2 = setTimeout(() => controller2.abort(), 5_000)
      try {
        const retryResponse = await fetch(decodedUrl, {
          signal: controller2.signal,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
            'Accept': 'image/*,*/*;q=0.8',
          },
        }).finally(() => clearTimeout(timeout2))

        if (retryResponse.ok) {
          const ct = safeImageContentType(retryResponse.headers.get('content-type'))
          const buf = await retryResponse.arrayBuffer()
          const origin2 = request.headers.get('Origin')
          return new NextResponse(buf, {
            headers: {
              'Content-Type': ct,
              'X-Content-Type-Options': 'nosniff',
              // 1-year immutable cache — avatars for a given seed/URL never change.
              'Cache-Control': `public, max-age=${CACHE_MAX_AGE}, immutable`,
              'Surrogate-Control': `max-age=${CACHE_MAX_AGE}`,
              'CDN-Cache-Control': `public, max-age=${CACHE_MAX_AGE}, immutable`,
              'Access-Control-Allow-Origin': getCorsOrigin(origin2),
            },
          })
        }
      } catch {
        // Retry failed, fall through to original error
      }
    }

    if (!response.ok) {
      return new NextResponse('Failed to fetch image', { status: response.status })
    }

    const contentType = safeImageContentType(response.headers.get('content-type'))
    const buffer = await response.arrayBuffer()

    const origin = request.headers.get('Origin')
    return new NextResponse(buffer, {
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
    // Distinguish upstream/network failures from true server errors so they
    // don't pollute 500 error dashboards.
    if (error instanceof Error) {
      if (error.name === 'AbortError') {
        // Upstream CDN timed out — this is not our fault
        return new NextResponse('Upstream timeout', { status: 504 })
      }
      const msg = error.message.toLowerCase()
      if (
        msg.includes('econnrefused') ||
        msg.includes('enotfound') ||
        msg.includes('econnreset') ||
        msg.includes('network') ||
        msg.includes('fetch failed')
      ) {
        // Upstream network error — return 502 Bad Gateway, not 500
        return new NextResponse('Upstream error', { status: 502 })
      }
    }
    logger.error('Avatar proxy error:', error)
    return new NextResponse('Internal error', { status: 500 })
  }
}
