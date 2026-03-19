/**
 * API 中间件工具
 * 提供统一的认证、限流、错误处理、版本控制
 */

import { NextRequest, NextResponse } from 'next/server'
import { User } from '@supabase/supabase-js'
import { getAuthUser, getSupabaseAdmin } from '@/lib/supabase/server'
import { checkRateLimitFull, addRateLimitHeaders, RateLimitPresets, type RateLimitConfig, type RateLimitResult } from '@/lib/utils/rate-limit'
import { createLogger } from '@/lib/utils/logger'
import { validateCsrfToken, CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from '@/lib/utils/csrf'
import {
  parseApiVersion,
  addVersionHeaders,
  addDeprecationHeaders,
  type VersionContext,
  type ApiVersion,
} from './versioning'
import { getOrCreateCorrelationId, runWithCorrelationId } from './correlation'

const logger = createLogger('api-middleware')

/**
 * API 处理函数上下文
 */
interface ApiContext {
  /** 认证用户（如果需要认证） */
  user?: User | null
  /** Supabase 管理员客户端 */
  supabase: ReturnType<typeof getSupabaseAdmin>
  /** 请求对象 */
  request: NextRequest
  /** API 版本上下文 */
  version: VersionContext
}

/**
 * API 处理函数类型
 */
type ApiHandler<T = unknown> = (ctx: ApiContext) => Promise<NextResponse | T>

/**
 * 中间件配置选项
 */
interface MiddlewareOptions {
  /** 是否需要认证 */
  requireAuth?: boolean
  /** 限流配置 */
  rateLimit?: RateLimitConfig | keyof typeof RateLimitPresets | false
  /** API 名称（用于日志） */
  name?: string
  /** 是否启用版本控制（默认 true） */
  versioning?: boolean
  /** 跳过 CSRF 验证（当有 auth 验证时可安全跳过） */
  skipCsrf?: boolean
}

// 导出版本类型供外部使用
export type { VersionContext, ApiVersion }

/**
 * 创建统一的 API 响应
 */
function createResponse(data: unknown, status = 200) {
  return NextResponse.json(data, { status })
}

/**
 * Map of safe, public-facing error messages by status code.
 * Prevents leaking internal details (stack traces, DB errors, etc.) to clients.
 */
const PUBLIC_ERROR_MESSAGES: Record<number, string> = {
  400: 'Bad request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not found',
  405: 'Method not allowed',
  409: 'Conflict',
  422: 'Unprocessable entity',
  429: 'Too many requests',
  500: 'Internal server error',
  502: 'Bad gateway',
  503: 'Service unavailable',
  504: 'Gateway timeout',
}

/**
 * Get a safe, public-facing error message for a given status code.
 * For 5xx errors, always returns a generic message regardless of input.
 * For 4xx errors, uses the provided message if it's considered safe, otherwise falls back to a generic message.
 */
function getSafeErrorMessage(message: string, status: number): string {
  // 5xx: always generic — never expose internal details
  if (status >= 500) {
    return PUBLIC_ERROR_MESSAGES[status] || 'Internal server error'
  }
  // 4xx: use provided message only if short and doesn't contain suspicious patterns
  // (stack traces, file paths, SQL fragments, etc.)
  const suspicious = /\b(at |Error:|ENOENT|ECONNREFUSED|\.ts:|\.js:|SELECT |INSERT |UPDATE |DELETE |FROM |WHERE |supabase|postgres|redis|node_modules)\b/i
  if (suspicious.test(message)) {
    return PUBLIC_ERROR_MESSAGES[status] || 'Request error'
  }
  return message
}

/**
 * 创建错误响应
 */
export function createErrorResponse(message: string, status = 500) {
  const safeMessage = getSafeErrorMessage(message, status)
  return NextResponse.json(
    { success: false, error: safeMessage },
    { status }
  )
}

/**
 * API 中间件包装器
 * 
 * @example
 * ```ts
 * // 需要认证的 API
 * export const POST = withApiMiddleware(
 *   async ({ user, supabase }) => {
 *     // 此处 user 一定存在
 *     return { success: true, userId: user.id }
 *   },
 *   { requireAuth: true, rateLimit: 'write' }
 * )
 * 
 * // 公开 API
 * export const GET = withApiMiddleware(
 *   async ({ supabase }) => {
 *     const { data } = await supabase.from('posts').select('*')
 *     return { success: true, data }
 *   },
 *   { rateLimit: 'public' }
 * )
 * ```
 */
export function withApiMiddleware<T>(
  handler: ApiHandler<T>,
  options: MiddlewareOptions = {}
): (request: NextRequest) => Promise<NextResponse> {
  const {
    requireAuth: needsAuth = false,
    rateLimit = needsAuth ? 'authenticated' : 'public',
    name = 'api',
    versioning = true,
    skipCsrf = false,
  } = options

  return async (request: NextRequest): Promise<NextResponse> => {
    const correlationId = getOrCreateCorrelationId(request)

    // Helper: attach correlation ID header to any response before returning
    const withCid = (res: NextResponse): NextResponse => {
      res.headers.set('X-Correlation-ID', correlationId)
      return res
    }

    return runWithCorrelationId(correlationId, async () => {
    const startTime = Date.now()

    // 0. Basic bot protection (blocks empty/script-like User-Agent)
    const ua = request.headers.get('user-agent') || ''
    if (!ua || ua.length < 8) {
      return withCid(createErrorResponse('Forbidden', 403))
    }

    // 解析 API 版本
    const versionContext = parseApiVersion(request)

    // Track rate limit metadata for injecting headers on successful responses
    let rateLimitMeta: RateLimitResult['meta'] = null

    try {
      // 1. 限流检查
      if (rateLimit !== false) {
        const config = typeof rateLimit === 'string'
          ? RateLimitPresets[rateLimit]
          : rateLimit

        const rateLimitResult = await checkRateLimitFull(request, config)
        rateLimitMeta = rateLimitResult.meta
        const rateLimitResponse = rateLimitResult.response
        if (rateLimitResponse) {
          logger.warn(`Rate limit exceeded for ${name}`, { correlationId })
          // 添加版本头到限流响应
          if (versioning) {
            addVersionHeaders(rateLimitResponse, versionContext)
          }
          return withCid(rateLimitResponse)
        }
      }

      // 2. 认证检查（在 CSRF 之前，确保未登录返回 401 而非 403）
      let user: User | null = null
      if (needsAuth) {
        user = await getAuthUser(request)
        if (!user) {
          const errorResponse = createErrorResponse('未授权', 401)
          if (versioning) {
            addVersionHeaders(errorResponse, versionContext)
          }
          return withCid(errorResponse)
        }
      } else {
        // Only attempt auth lookup if Authorization header is present (avoid 2 wasted DB calls on public requests)
        const authHeader = request.headers.get('authorization')
        if (authHeader) {
          user = await getAuthUser(request)
        }
      }

      // 3. CSRF 验证（仅针对写操作，可通过 skipCsrf 跳过）
      const method = request.method.toUpperCase()
      if (!skipCsrf && ['POST', 'PUT', 'DELETE', 'PATCH'].includes(method)) {
        const cookieToken = request.cookies.get(CSRF_COOKIE_NAME)?.value
        const headerToken = request.headers.get(CSRF_HEADER_NAME) ?? undefined

        if (!validateCsrfToken(cookieToken, headerToken)) {
          logger.warn(`CSRF validation failed for ${name}`, { correlationId })
          const csrfErrorResponse = createErrorResponse('CSRF 验证失败', 403)
          if (versioning) {
            addVersionHeaders(csrfErrorResponse, versionContext)
          }
          return withCid(csrfErrorResponse)
        }
      }

      // 4. 获取 Supabase 客户端
      const supabase = getSupabaseAdmin()

      // 5. 执行处理函数（传入版本上下文）
      const result = await handler({ user, supabase, request, version: versionContext })

      // 6. 返回响应
      let response: NextResponse
      if (result instanceof NextResponse) {
        response = result
      } else {
        response = createResponse({ success: true, data: result })
      }

      // 7. 添加版本和弃用头
      if (versioning) {
        addVersionHeaders(response, versionContext)
        addDeprecationHeaders(response, versionContext)
      }

      // 8. 添加限流响应头到所有成功响应
      if (rateLimitMeta) {
        addRateLimitHeaders(response, rateLimitMeta.limit, rateLimitMeta.remaining, rateLimitMeta.reset)
      }

      // 9. 添加响应时间头 & 慢查询日志
      const duration = Date.now() - startTime
      response.headers.set('X-Response-Time', `${duration}ms`)
      response.headers.set('X-Correlation-ID', correlationId)
      // Server-Timing header — visible in Chrome DevTools Network tab (OpenTelemetry-lite)
      response.headers.set('Server-Timing', `api;dur=${duration};desc="${name}"`)


      if (duration >= 3000) {
        logger.error(`CRITICAL SLOW API: ${name} took ${duration}ms`, { path: request.nextUrl.pathname, correlationId })
      } else if (duration >= 1000) {
        logger.warn(`Slow API: ${name} took ${duration}ms`, { path: request.nextUrl.pathname, correlationId })
      }

      return withCid(response)
    } catch (error: unknown) {
      const statusCode = error instanceof Error && 'statusCode' in error
        ? (error as { statusCode: number }).statusCode
        : 500
      const internalMessage = error instanceof Error ? error.message : '服务器内部错误'
      const duration = Date.now() - startTime

      if (statusCode >= 500) {
        logger.error(`${name} error: ${internalMessage}`, { error: String(error), duration, correlationId })
      } else {
        logger.warn(`${name} client error: ${internalMessage}`, { duration, correlationId })
      }

      // Sanitize error messages — createErrorResponse applies safe message filtering
      const errorResponse = createErrorResponse(internalMessage, statusCode)
      if (versioning) {
        addVersionHeaders(errorResponse, versionContext)
      }
      errorResponse.headers.set('X-Response-Time', `${duration}ms`)

      return withCid(errorResponse)
    }
    }) // end runWithCorrelationId
  }
}

/**
 * 快捷方法：创建需要认证的 API 处理器
 */
export function withAuth<T>(
  handler: (ctx: ApiContext & { user: User }) => Promise<NextResponse | T>,
  options: Omit<MiddlewareOptions, 'requireAuth'> = {}
) {
  return withApiMiddleware(
    handler as ApiHandler<T>,
    { ...options, requireAuth: true }
  )
}

/**
 * 快捷方法：创建公开 API 处理器
 */
export function withPublic<T>(
  handler: ApiHandler<T>,
  options: Omit<MiddlewareOptions, 'requireAuth'> = {}
) {
  return withApiMiddleware(handler, { ...options, requireAuth: false })
}
