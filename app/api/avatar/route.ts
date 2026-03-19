/**
 * 头像代理 API
 * 解决跨域和 referrer 限制问题
 */

import { NextResponse } from 'next/server'
import logger from '@/lib/logger'
import { getCorsOrigin } from '@/lib/utils/cors'

export const dynamic = 'force-dynamic'

// Pin to Tokyo — exchange CDNs are geo-blocked from US regions
export const preferredRegion = 'hnd1'

// 缓存时间：7 天
const CACHE_MAX_AGE = 60 * 60 * 24 * 7

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const url = searchParams.get('url')

  if (!url) {
    return new NextResponse('Missing url parameter', { status: 400 })
  }

  try {
    // 解码 URL
    const decodedUrl = decodeURIComponent(url)
    
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
      'cloudfront.net',
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
    const isAllowed = allowedDomains.some(domain => urlObj.hostname.includes(domain))
    
    if (!isAllowed) {
      return new NextResponse('Domain not allowed', { status: 403 })
    }

    // 请求图片 - 模拟浏览器请求（10s timeout 防止 function 挂起）
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10_000)

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

    if (!response.ok && (response.status === 403 || response.status === 401)) {
      // Retry with minimal headers — some CDNs block specific header combos
      const controller2 = new AbortController()
      const timeout2 = setTimeout(() => controller2.abort(), 8_000)
      try {
        const retryResponse = await fetch(decodedUrl, {
          signal: controller2.signal,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
            'Accept': 'image/*,*/*;q=0.8',
          },
        }).finally(() => clearTimeout(timeout2))

        if (retryResponse.ok) {
          const ct = retryResponse.headers.get('content-type') || 'image/png'
          const buf = await retryResponse.arrayBuffer()
          const origin2 = request.headers.get('Origin')
          return new NextResponse(buf, {
            headers: {
              'Content-Type': ct,
              'Cache-Control': `public, max-age=${CACHE_MAX_AGE}`,
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

    const contentType = response.headers.get('content-type') || 'image/png'
    const buffer = await response.arrayBuffer()

    const origin = request.headers.get('Origin')
    return new NextResponse(buffer, {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': `public, max-age=${CACHE_MAX_AGE}`,
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
