/**
 * Next.js 16 Proxy
 * 实现统一的认证、CORS、安全头、CSRF 保护、请求追踪
 */

import { NextResponse, type NextRequest } from 'next/server'
import { Ratelimit } from '@upstash/ratelimit'
import { Redis } from '@upstash/redis'
import { generateRequestId } from '@/lib/utils/logger'

// CSRF 配置
const CSRF_COOKIE_NAME = 'csrf-token'
const CSRF_HEADER_NAME = 'x-csrf-token'
const CSRF_TOKEN_EXPIRY = 24 * 60 * 60 * 1000 // 24 小时

// 需要 CSRF 保护的方法
const CSRF_PROTECTED_METHODS = ['POST', 'PUT', 'DELETE', 'PATCH']

// 豁免 CSRF 检查的路由（这些路由通过 Authentication 或 rate limiting 保护）
const CSRF_EXEMPT_ROUTES = [
  '/api/auth',
  '/api/cron',
  '/api/health',
  '/api/webhook',
  '/api/stripe',           // Stripe API 通过 Authorization header 验证
  '/api/translate',        // 翻译 API 使用 rate limiting 保护
  '/api/posts',            // 帖子相关 API 需要认证
  '/api/comments',         // 评论相关 API 需要认证
  '/api/bookmark',         // 收藏相关 API 需要认证
  '/api/bookmark-folders', // 收藏夹 API 需要认证
  '/api/users/follow',     // 关注 API 需要认证
  '/api/follow',           // 交易员关注 API 需要认证
  '/api/messages',         // 消息 API 需要认证
  '/api/notifications',    // 通知 API 需要认证
  '/api/upload-profile-image', // 头像/背景图上传 API，通过 userId 验证
]

// 需要认证的路由前缀
const PROTECTED_ROUTES = [
  '/api/posts',
  '/api/comments',
  '/api/bookmark',
  '/api/messages',
  '/api/notifications',
  '/api/users/follow',
  '/api/exchange/oauth',
  '/settings',
  '/my-posts',
  '/favorites',
]

// 公开路由（即使匹配 PROTECTED_ROUTES 也允许）
const PUBLIC_ROUTES = [
  '/api/posts', // GET 请求允许
  '/api/comments', // GET 请求允许
]

// 需要跳过的路由
const SKIP_ROUTES = [
  '/_next',
  '/favicon.ico',
  '/api/health',
  '/api/cron',
]

// ============================================
// Rate Limiting
// ============================================

let ratelimit: Ratelimit | null = null
function getRateLimiter(): Ratelimit | null {
  if (ratelimit) return ratelimit
  const url = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN
  if (!url || !token) return null
  try {
    ratelimit = new Ratelimit({
      redis: new Redis({ url, token }),
      limiter: Ratelimit.slidingWindow(120, '60 s'),
      prefix: 'mw:ratelimit',
      analytics: false,
    })
    return ratelimit
  } catch {
    return null
  }
}

let writeRatelimit: Ratelimit | null = null
function getWriteRateLimiter(): Ratelimit | null {
  if (writeRatelimit) return writeRatelimit
  const url = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN
  if (!url || !token) return null
  try {
    writeRatelimit = new Ratelimit({
      redis: new Redis({ url, token }),
      limiter: Ratelimit.slidingWindow(30, '60 s'),
      prefix: 'mw:ratelimit:write',
      analytics: false,
    })
    return writeRatelimit
  } catch {
    return null
  }
}

const WRITE_PATHS = [
  '/api/posts',
  '/api/comments',
  '/api/trader-alerts',
  '/api/saved-filters',
  '/api/avoid-list',
]

// 允许的 CORS 源
const ALLOWED_ORIGINS = [
  process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000',
  'https://ranking-arena.vercel.app',
]

/**
 * 生成 Content Security Policy
 */
function generateCsp(): string {
  const isProduction = process.env.NODE_ENV === 'production'
  
  // CSP 指令
  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    'script-src': [
      "'self'",
      "'unsafe-inline'", // 用于 Next.js 内联脚本
      "'unsafe-eval'", // 开发环境需要
      'https://vercel.live',
      'https://*.vercel-scripts.com',
      'https://static.cloudflareinsights.com',
      'https://js.stripe.com',
      'https://challenges.cloudflare.com',
    ],
    'style-src': [
      "'self'",
      "'unsafe-inline'", // Tailwind CSS 需要
    ],
    'img-src': [
      "'self'",
      'data:',
      'blob:',
      'https://*.supabase.co',
      'https://assets.coingecko.com',
      'https://api.dicebear.com',
      'https://avatars.githubusercontent.com',
      // 交易所头像域名
      'https://*.bgstatic.com',       // Bitget
      'https://*.bycsi.com',          // Bybit
      'https://*.bnbstatic.com',      // Binance
      'https://*.nftstatic.com',      // Binance NFT
      'https://*.myqcloud.com',       // 腾讯云 CDN (MEXC等)
      'https://*.mocortech.com',      // MEXC
      'https://*.tylhh.net',          // 其他交易所
      'https://*.bscdnweb.com',       // BSC
    ],
    'font-src': ["'self'", 'data:'],
    'connect-src': [
      "'self'",
      'https://*.supabase.co',
      'wss://*.supabase.co',
      'https://*.upstash.io',
      'https://vercel.live',
      'wss://ws-us3.pusher.com',
      // Sentry (wildcard only matches one subdomain level)
      'https://*.ingest.sentry.io',
      'https://*.ingest.us.sentry.io',
      'https://*.sentry.io',
    ],
    'frame-src': [
      "'self'",
      'https://vercel.live',
    ],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
    'frame-ancestors': ["'none'"],
    'upgrade-insecure-requests': [],
  }
  
  // 生产环境移除 unsafe-eval
  if (isProduction) {
    directives['script-src'] = directives['script-src'].filter(d => d !== "'unsafe-eval'")
  }
  
  // 构建 CSP 字符串
  return Object.entries(directives)
    .map(([key, values]) => {
      if (values.length === 0) return key
      return `${key} ${values.join(' ')}`
    })
    .join('; ')
}

/**
 * 添加安全响应头
 */
function addSecurityHeaders(response: NextResponse, isHtmlPage = false): NextResponse {
  // 防止 MIME 类型嗅探
  response.headers.set('X-Content-Type-Options', 'nosniff')
  
  // 防止点击劫持
  response.headers.set('X-Frame-Options', 'DENY')
  
  // XSS 过滤器
  response.headers.set('X-XSS-Protection', '1; mode=block')
  
  // 引用来源策略
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin')
  
  // 权限策略
  response.headers.set(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), interest-cohort=()'
  )
  
  // Content Security Policy (仅 HTML 页面)
  if (isHtmlPage) {
    response.headers.set('Content-Security-Policy', generateCsp())
  }
  
  // HSTS (仅生产环境)
  if (process.env.NODE_ENV === 'production') {
    response.headers.set(
      'Strict-Transport-Security',
      'max-age=31536000; includeSubDomains; preload'
    )
  }
  
  return response
}

/**
 * 添加 CORS 响应头
 */
function addCorsHeaders(request: NextRequest, response: NextResponse): NextResponse {
  const origin = request.headers.get('origin')
  
  // 检查是否允许的源
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    response.headers.set('Access-Control-Allow-Origin', origin)
  }
  
  response.headers.set('Access-Control-Allow-Credentials', 'true')
  response.headers.set(
    'Access-Control-Allow-Methods',
    'GET, POST, PUT, DELETE, PATCH, OPTIONS'
  )
  response.headers.set(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, X-CSRF-Token, X-Requested-With'
  )
  response.headers.set('Access-Control-Max-Age', '86400')
  
  return response
}

/**
 * 检查路由是否需要认证
 */
function isProtectedRoute(pathname: string, method: string): boolean {
  // GET 请求到公开 API 不需要认证
  if (method === 'GET' && PUBLIC_ROUTES.some(route => pathname.startsWith(route))) {
    return false
  }
  
  return PROTECTED_ROUTES.some(route => pathname.startsWith(route))
}

/**
 * 检查是否应跳过代理
 */
function shouldSkip(pathname: string): boolean {
  return SKIP_ROUTES.some(route => pathname.startsWith(route))
}

/**
 * 检查是否需要 CSRF 保护
 */
function requiresCsrfProtection(pathname: string, method: string): boolean {
  // 只有状态改变的请求需要 CSRF 保护
  if (!CSRF_PROTECTED_METHODS.includes(method)) {
    return false
  }
  
  // 只有 API 路由需要 CSRF 保护
  if (!pathname.startsWith('/api/')) {
    return false
  }
  
  // 豁免路由不需要 CSRF 保护
  if (CSRF_EXEMPT_ROUTES.some(route => pathname.startsWith(route))) {
    return false
  }
  
  return true
}

/**
 * 验证带时间戳的 CSRF Token
 */
function validateTimedCsrfToken(token: string): boolean {
  if (!token) return false
  
  const parts = token.split('.')
  if (parts.length !== 2) return false
  
  const [timestampStr, tokenPart] = parts
  
  // 验证 token 部分长度（64 hex chars = 32 bytes）
  if (tokenPart.length !== 64) return false
  
  try {
    const timestamp = parseInt(timestampStr, 36)
    const now = Date.now()
    
    // Token 已过期
    if (now - timestamp > CSRF_TOKEN_EXPIRY) {
      return false
    }
    
    return true
  } catch {
    return false
  }
}

/**
 * 验证 CSRF Token
 */
function validateCsrf(request: NextRequest): boolean {
  const cookieToken = request.cookies.get(CSRF_COOKIE_NAME)?.value
  const headerToken = request.headers.get(CSRF_HEADER_NAME)
  
  if (!cookieToken || !headerToken) {
    return false
  }
  
  // 验证 token 格式和时间
  if (!validateTimedCsrfToken(cookieToken) || !validateTimedCsrfToken(headerToken)) {
    return false
  }
  
  // 比较两个 token（简单比较，因为都来自客户端）
  return cookieToken === headerToken
}

/**
 * 验证 Authorization header 中的 token
 */
function hasValidAuthHeader(request: NextRequest): boolean {
  const authHeader = request.headers.get('authorization')
  if (!authHeader) return false
  
  // 检查 Bearer token 格式
  if (!authHeader.startsWith('Bearer ')) return false
  
  const token = authHeader.slice(7)
  // 基本验证：token 不为空且长度合理
  return token.length > 20
}

/**
 * 检查 cookie 中是否有 session
 */
function hasSessionCookie(request: NextRequest): boolean {
  const cookies = request.cookies
  // Supabase v2 使用 sb-<project-ref>-auth-token 格式的 cookie
  // 检查所有可能的 cookie 名称
  const allCookies = cookies.getAll()
  return allCookies.some(cookie => 
    cookie.name.startsWith('sb-') && 
    (cookie.name.includes('-auth-token') || cookie.name.includes('access-token') || cookie.name.includes('refresh-token'))
  ) || !!(
    cookies.get('sb-access-token') ||
    cookies.get('sb-refresh-token') ||
    cookies.get('supabase-auth-token')
  )
}

/**
 * Next.js 16 Proxy 函数
 */
export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl
  const method = request.method
  
  // 跳过不需要处理的路由
  if (shouldSkip(pathname)) {
    return NextResponse.next()
  }
  
  // 生成请求 ID 用于追踪
  const requestId = generateRequestId()
  
  // 处理 CORS 预检请求
  if (method === 'OPTIONS') {
    const response = new NextResponse(null, { status: 204 })
    addCorsHeaders(request, response)
    addSecurityHeaders(response)
    response.headers.set('X-Request-ID', requestId)
    return response
  }
  
  // API 路由限流检查
  if (pathname.startsWith('/api/')) {
    const isWriteMethod = ['POST', 'PUT', 'DELETE', 'PATCH'].includes(method)
    const isWritePath = WRITE_PATHS.some(p => pathname.startsWith(p))
    const useWriteLimit = isWriteMethod && isWritePath
    const limiter = useWriteLimit ? getWriteRateLimiter() : getRateLimiter()

    if (limiter) {
      try {
        const forwarded = request.headers.get('x-forwarded-for')
        const ip = forwarded?.split(',')[0]?.trim() || request.headers.get('x-real-ip') || 'anonymous'
        const { success, limit, remaining, reset } = await limiter.limit(ip)

        if (!success) {
          const rateLimitResponse = NextResponse.json(
            { success: false, error: '请求过于频繁，请稍后再试', code: 'RATE_LIMIT_EXCEEDED' },
            { status: 429 }
          )
          rateLimitResponse.headers.set('X-RateLimit-Limit', limit.toString())
          rateLimitResponse.headers.set('X-RateLimit-Remaining', remaining.toString())
          rateLimitResponse.headers.set('X-RateLimit-Reset', reset.toString())
          rateLimitResponse.headers.set('X-Request-ID', requestId)
          addCorsHeaders(request, rateLimitResponse)
          return rateLimitResponse
        }
      } catch {
        // 限流检查失败时放行 (fail-open)
      }
    }
  }

  // 检查受保护路由的认证（仅 API 路由）
  // 页面路由让客户端自己处理认证，避免 cookie 检查不准确导致的错误重定向
  if (isProtectedRoute(pathname, method) && pathname.startsWith('/api/')) {
    const hasAuth = hasValidAuthHeader(request) || hasSessionCookie(request)
    
    if (!hasAuth) {
      // API 路由返回 401
      const response = NextResponse.json(
        {
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: '未授权，请先登录',
          },
        },
        { status: 401 }
      )
      addCorsHeaders(request, response)
      addSecurityHeaders(response)
      response.headers.set('X-Request-ID', requestId)
      return response
    }
  }
  
  // CSRF 保护检查
  if (requiresCsrfProtection(pathname, method)) {
    if (!validateCsrf(request)) {
      const response = NextResponse.json(
        {
          success: false,
          error: {
            code: 'CSRF_VALIDATION_FAILED',
            message: 'CSRF 验证失败，请刷新页面重试',
          },
        },
        { status: 403 }
      )
      addCorsHeaders(request, response)
      addSecurityHeaders(response)
      response.headers.set('X-Request-ID', requestId)
      return response
    }
  }
  
  // 继续处理请求
  const response = NextResponse.next()
  
  // 添加请求 ID
  response.headers.set('X-Request-ID', requestId)
  
  // 检测是否是 HTML 页面请求
  const acceptHeader = request.headers.get('accept') || ''
  const isHtmlPage = !pathname.startsWith('/api/') && acceptHeader.includes('text/html')
  
  // 添加安全头
  addSecurityHeaders(response, isHtmlPage)
  
  // API 路由添加 CORS 头
  if (pathname.startsWith('/api/')) {
    addCorsHeaders(request, response)
  }
  
  return response
}

// 配置代理匹配的路由
export const config = {
  matcher: [
    /*
     * 匹配所有路由，除了：
     * - _next/static (静态文件)
     * - _next/image (图片优化)
     * - favicon.ico, sitemap.xml, robots.txt
     */
    '/((?!_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt).*)',
  ],
}
