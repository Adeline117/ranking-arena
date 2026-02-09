/**
 * 头像代理 API
 * 解决跨域和 referrer 限制问题
 */

import { NextResponse } from 'next/server'
import logger from '@/lib/logger'

export const dynamic = 'force-dynamic'

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
      // Pionex
      'pionex.com',
      // Weex
      'weex.com',
      'wexx.one',
      // Blofin
      'blofin.com',
      // Our CDN
      'arenafi.org',
      // GitHub
      'githubusercontent.com',
      // Google
      'googleusercontent.com',
      'google.com',
    ]
    
    const urlObj = new URL(decodedUrl)
    const isAllowed = allowedDomains.some(domain => urlObj.hostname.includes(domain))
    
    if (!isAllowed) {
      return new NextResponse('Domain not allowed', { status: 403 })
    }

    // 请求图片 - 模拟浏览器请求
    const response = await fetch(decodedUrl, {
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
    })

    if (!response.ok) {
      return new NextResponse('Failed to fetch image', { status: response.status })
    }

    const contentType = response.headers.get('content-type') || 'image/png'
    const buffer = await response.arrayBuffer()

    return new NextResponse(buffer, {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': `public, max-age=${CACHE_MAX_AGE}`,
        'Access-Control-Allow-Origin': '*',
      },
    })
  } catch (error: unknown) {
    logger.error('Avatar proxy error:', error)
    return new NextResponse('Internal error', { status: 500 })
  }
}
