import { NextRequest, NextResponse } from 'next/server'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import logger from '@/lib/logger'

// 简单的 HTML 解析函数
function extractMetaTags(html: string) {
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i)
  const ogTitleMatch = html.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i)
  const ogDescriptionMatch = html.match(/<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']+)["']/i)
  const ogImageMatch = html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i)
  const descriptionMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i)

  return {
    title: ogTitleMatch?.[1] || titleMatch?.[1] || '',
    description: ogDescriptionMatch?.[1] || descriptionMatch?.[1] || '',
    image: ogImageMatch?.[1] || '',
  }
}

export async function GET(request: NextRequest) {
  try {
    const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.public)
    if (rateLimitResponse) return rateLimitResponse

    const { searchParams } = new URL(request.url)
    const url = searchParams.get('url')

    if (!url) {
      return NextResponse.json({ error: 'URL parameter is required' }, { status: 400 })
    }

    // 验证 URL 格式
    let validUrl: URL
    try {
      validUrl = new URL(url)
    } catch {
      return NextResponse.json({ error: 'Invalid URL format' }, { status: 400 })
    }

    // 只允许 http/https
    if (!['http:', 'https:'].includes(validUrl.protocol)) {
      return NextResponse.json({ error: 'Only HTTP/HTTPS URLs are allowed' }, { status: 400 })
    }

    // SSRF protection: block internal/private IPs and cloud metadata endpoints
    const hostname = validUrl.hostname.toLowerCase()
    const blockedHostnames = ['localhost', '0.0.0.0', '[::1]', 'metadata.google.internal']
    if (blockedHostnames.includes(hostname)) {
      return NextResponse.json({ error: 'URL not allowed' }, { status: 400 })
    }

    // Block private/reserved IP ranges
    const ipv4Match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
    if (ipv4Match) {
      const [, a, b] = ipv4Match.map(Number)
      if (
        a === 127 ||                          // 127.0.0.0/8 loopback
        a === 10 ||                           // 10.0.0.0/8 private
        (a === 172 && b >= 16 && b <= 31) ||  // 172.16.0.0/12 private
        (a === 192 && b === 168) ||           // 192.168.0.0/16 private
        (a === 169 && b === 254) ||           // 169.254.0.0/16 link-local + cloud metadata
        a === 0                               // 0.0.0.0/8
      ) {
        return NextResponse.json({ error: 'URL not allowed' }, { status: 400 })
      }
    }

    // 获取 HTML
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      signal: AbortSignal.timeout(10000), // 10秒超时
    })

    if (!response.ok) {
      return NextResponse.json({ error: 'Failed to fetch URL' }, { status: response.status })
    }

    const html = await response.text()
    const meta = extractMetaTags(html)

    // 处理相对路径的图片 URL
    if (meta.image && !meta.image.startsWith('http')) {
      try {
        meta.image = new URL(meta.image, validUrl.origin).href
      } catch {
        meta.image = ''
      }
    }

    return NextResponse.json(meta, {
      headers: {
        'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=86400',
      },
    })
  } catch (error: unknown) {
    logger.error('Error fetching link preview:', error)
    return NextResponse.json(
      { error: 'Failed to fetch link preview' },
      { status: 500 }
    )
  }
}

