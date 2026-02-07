/**
 * API 中间件工具
 * 提供统一的认证、限流、错误处理、版本控制
 */

import { NextRequest, NextResponse } from 'next/server'
import { User } from '@supabase/supabase-js'
import { getAuthUser, getSupabaseAdmin } from '@/lib/supabase/server'
import { checkRateLimit, RateLimitPresets, type RateLimitConfig } from '@/lib/utils/rate-limit'
import { createLogger } from '@/lib/utils/logger'
import { validateCsrfToken, CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from '@/lib/utils/csrf'
import { 
  parseApiVersion, 
  addVersionHeaders, 
  addDeprecationHeaders,
  type VersionContext,
  type ApiVersion,
} from './versioning'

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
 * 创建错误响应
 */
export function createErrorResponse(message: string, status = 500) {
  return NextResponse.json(
    { success: false, error: message },
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
  } = options

  return async (request: NextRequest): Promise<NextResponse> => {
    const startTime = Date.now()
    
    // 解析 API 版本
    const versionContext = parseApiVersion(request)
    
    try {
      // 1. 限流检查
      if (rateLimit !== false) {
        const config = typeof rateLimit === 'string'
          ? RateLimitPresets[rateLimit]
          : rateLimit

        const rateLimitResponse = await checkRateLimit(request, config)
        if (rateLimitResponse) {
          logger.warn(`Rate limit exceeded for ${name}`)
          // 添加版本头到限流响应
          if (versioning) {
            addVersionHeaders(rateLimitResponse, versionContext)
          }
          return rateLimitResponse
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
          return errorResponse
        }
      } else {
        // 即使不需要认证，也尝试获取用户信息
        user = await getAuthUser(request)
      }

      // 3. CSRF 验证（仅针对写操作）
      const method = request.method.toUpperCase()
      if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(method)) {
        const cookieToken = request.cookies.get(CSRF_COOKIE_NAME)?.value
        const headerToken = request.headers.get(CSRF_HEADER_NAME) ?? undefined

        if (!validateCsrfToken(cookieToken, headerToken)) {
          logger.warn(`CSRF validation failed for ${name}`)
          const csrfErrorResponse = createErrorResponse('CSRF 验证失败', 403)
          if (versioning) {
            addVersionHeaders(csrfErrorResponse, versionContext)
          }
          return csrfErrorResponse
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

      // 8. 添加响应时间头
      const duration = Date.now() - startTime
      response.headers.set('X-Response-Time', `${duration}ms`)

      return response
    } catch (error: unknown) {
      const statusCode = error instanceof Error && 'statusCode' in error
        ? (error as { statusCode: number }).statusCode
        : 500
      const message = error instanceof Error ? error.message : '服务器内部错误'
      const duration = Date.now() - startTime

      if (statusCode >= 500) {
        logger.error(`${name} error: ${message}`, { error: String(error), duration })
      } else {
        logger.warn(`${name} client error: ${message}`, { duration })
      }

      const errorResponse = createErrorResponse(message, statusCode)
      if (versioning) {
        addVersionHeaders(errorResponse, versionContext)
      }
      errorResponse.headers.set('X-Response-Time', `${duration}ms`)
      
      return errorResponse
    }
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
