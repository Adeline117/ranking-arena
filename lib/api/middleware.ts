/**
 * API 中间件工具
 * 提供统一的认证、限流、错误处理
 */

import { NextRequest, NextResponse } from 'next/server'
import { User } from '@supabase/supabase-js'
import { getAuthUser, getSupabaseAdmin } from '@/lib/supabase/server'
import { checkRateLimit, RateLimitPresets, type RateLimitConfig } from '@/lib/utils/rate-limit'
import { createLogger } from '@/lib/utils/logger'

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
}

/**
 * 创建统一的 API 响应
 */
function createResponse(data: unknown, status = 200) {
  return NextResponse.json(data, { status })
}

/**
 * 创建错误响应
 */
function createErrorResponse(message: string, status = 500) {
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
  } = options

  return async (request: NextRequest): Promise<NextResponse> => {
    try {
      // 1. 限流检查
      if (rateLimit !== false) {
        const config = typeof rateLimit === 'string' 
          ? RateLimitPresets[rateLimit]
          : rateLimit
        
        const rateLimitResponse = await checkRateLimit(request, config)
        if (rateLimitResponse) {
          logger.warn(`Rate limit exceeded for ${name}`)
          return rateLimitResponse
        }
      }

      // 2. 认证检查
      let user: User | null = null
      if (needsAuth) {
        user = await getAuthUser(request)
        if (!user) {
          return createErrorResponse('未授权', 401)
        }
      } else {
        // 即使不需要认证，也尝试获取用户信息
        user = await getAuthUser(request)
      }

      // 3. 获取 Supabase 客户端
      const supabase = getSupabaseAdmin()

      // 4. 执行处理函数
      const result = await handler({ user, supabase, request })

      // 5. 返回响应
      if (result instanceof NextResponse) {
        return result
      }

      return createResponse({ success: true, data: result })
    } catch (error: any) {
      // 错误处理
      const statusCode = error.statusCode || 500
      const message = error.message || '服务器内部错误'

      if (statusCode >= 500) {
        logger.error(`${name} error: ${message}`, { error: String(error) })
      } else {
        logger.warn(`${name} client error: ${message}`)
      }

      return createErrorResponse(message, statusCode)
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

