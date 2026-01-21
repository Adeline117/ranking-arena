/**
 * 统一 API 响应辅助函数
 * 提供标准化的响应格式和错误处理
 */

import { NextResponse } from 'next/server'
import { ApiError, ErrorCode, ErrorCodeType, ErrorCodeToHttpStatus } from './errors'

// ============================================
// 响应类型定义
// ============================================

export interface ApiSuccessResponse<T = unknown> {
  success: true
  data: T
  meta?: {
    pagination?: {
      limit: number
      offset: number
      has_more: boolean
      total?: number
    }
    timestamp?: string
    requestId?: string
  }
}

export interface ApiErrorResponse {
  success: false
  error: {
    code: string
    message: string
    details?: Record<string, unknown>
    timestamp: string
  }
}

export type ApiResponse<T = unknown> = ApiSuccessResponse<T> | ApiErrorResponse

// ============================================
// 成功响应
// ============================================

/**
 * 标准成功响应
 */
export function success<T>(data: T, status = 200): NextResponse<ApiSuccessResponse<T>> {
  return NextResponse.json(
    {
      success: true as const,
      data,
      meta: {
        timestamp: new Date().toISOString(),
      },
    },
    { status }
  )
}

/**
 * 带分页的成功响应
 */
export function successWithPagination<T>(
  data: T,
  pagination: { limit: number; offset: number; has_more: boolean; total?: number },
  status = 200
): NextResponse<ApiSuccessResponse<T>> {
  return NextResponse.json(
    {
      success: true as const,
      data,
      meta: {
        pagination,
        timestamp: new Date().toISOString(),
      },
    },
    { status }
  )
}

/**
 * 空成功响应（如 DELETE 操作）
 */
export function successNoContent(): NextResponse {
  return new NextResponse(null, { status: 204 })
}

/**
 * 创建成功响应（201）
 */
export function created<T>(data: T): NextResponse<ApiSuccessResponse<T>> {
  return success(data, 201)
}

// ============================================
// 错误响应
// ============================================

/**
 * 标准错误响应
 */
export function error(
  message: string,
  status = 400,
  code: ErrorCodeType = ErrorCode.UNKNOWN_ERROR,
  details?: Record<string, unknown>
): NextResponse<ApiErrorResponse> {
  return NextResponse.json(
    {
      success: false as const,
      error: {
        code,
        message,
        ...(details && { details }),
        timestamp: new Date().toISOString(),
      },
    },
    { status }
  )
}

/**
 * 从 ApiError 创建响应
 */
export function errorFromApiError(apiError: ApiError): NextResponse<ApiErrorResponse> {
  return NextResponse.json(apiError.toJSON(), { status: apiError.statusCode })
}

/**
 * 未授权响应 (401)
 */
export function unauthorized(message = '未授权'): NextResponse<ApiErrorResponse> {
  return error(message, 401, ErrorCode.UNAUTHORIZED)
}

/**
 * 禁止访问响应 (403)
 */
export function forbidden(message = '禁止访问'): NextResponse<ApiErrorResponse> {
  return error(message, 403, ErrorCode.FORBIDDEN)
}

/**
 * 未找到响应 (404)
 */
export function notFound(message = '未找到'): NextResponse<ApiErrorResponse> {
  return error(message, 404, ErrorCode.NOT_FOUND)
}

/**
 * 冲突响应 (409)
 */
export function conflict(message = '资源已存在'): NextResponse<ApiErrorResponse> {
  return error(message, 409, ErrorCode.RESOURCE_EXISTS)
}

/**
 * 服务器错误响应 (500)
 */
export function serverError(message = '服务器错误'): NextResponse<ApiErrorResponse> {
  return error(message, 500, ErrorCode.INTERNAL_ERROR)
}

/**
 * 参数验证错误响应 (400)
 */
export function validationError(
  message: string,
  details?: Record<string, unknown>
): NextResponse<ApiErrorResponse> {
  return error(message, 400, ErrorCode.VALIDATION_ERROR, details)
}

/**
 * 错误请求响应 (400)
 */
export function badRequest(message = '请求参数错误'): NextResponse<ApiErrorResponse> {
  return error(message, 400, ErrorCode.INVALID_INPUT)
}

/**
 * 限流错误响应 (429)
 */
export function rateLimitError(
  retryAfter?: number
): NextResponse<ApiErrorResponse> {
  const response = error(
    '请求过于频繁，请稍后再试',
    429,
    ErrorCode.RATE_LIMIT_EXCEEDED,
    retryAfter ? { retryAfter, retryable: true } : { retryable: true }
  )

  if (retryAfter) {
    response.headers.set('Retry-After', String(retryAfter))
  }

  return response
}

/**
 * 提供商限流错误响应 (429)
 * 用于外部 API 提供商（如 AI 服务）返回的限流错误
 */
export function providerRateLimitError(
  retryAfter?: number,
  providerName?: string
): NextResponse<ApiErrorResponse> {
  const message = providerName
    ? `${providerName} 服务请求频率超限，请稍后再试`
    : '服务请求频率超限，请稍后再试'

  const response = error(
    message,
    429,
    ErrorCode.PROVIDER_RATE_LIMIT,
    {
      retryAfter,
      provider: providerName,
      retryable: true,
    }
  )

  if (retryAfter) {
    response.headers.set('Retry-After', String(retryAfter))
  }

  return response
}

/**
 * 提供商错误响应 (502)
 * 用于外部 API 提供商返回的其他错误
 */
export function providerError(
  message?: string,
  retryable = false
): NextResponse<ApiErrorResponse> {
  return error(
    message || '外部服务提供商错误',
    502,
    ErrorCode.PROVIDER_ERROR,
    { retryable }
  )
}

// ============================================
// 统一错误处理
// ============================================

/**
 * 处理异常并返回适当的响应
 * 自动识别错误类型并返回标准化的响应
 */
export function handleError(err: unknown, context?: string): NextResponse<ApiErrorResponse> {
  // 如果已经是 ApiError，直接转换
  if (err instanceof ApiError) {
    if (context) {
      console.error(`[${context}] ApiError:`, err.message, { code: err.code })
    }
    return errorFromApiError(err)
  }

  // 转换为 ApiError
  const apiError = ApiError.from(err, context)
  
  // 生产环境隐藏内部错误详情
  const isProduction = process.env.NODE_ENV === 'production'
  if (isProduction && apiError.statusCode >= 500) {
    return error(
      '服务器错误，请稍后重试',
      500,
      ErrorCode.INTERNAL_ERROR
    )
  }

  return errorFromApiError(apiError)
}

// ============================================
// 响应辅助函数
// ============================================

/**
 * 添加缓存控制头
 */
export function withCache(
  response: NextResponse,
  options: {
    maxAge?: number
    staleWhileRevalidate?: number
    isPublic?: boolean
  } = {}
): NextResponse {
  const { maxAge = 60, staleWhileRevalidate = 300, isPublic = true } = options
  
  const cacheControl = [
    isPublic ? 'public' : 'private',
    `max-age=${maxAge}`,
    `s-maxage=${maxAge}`,
    `stale-while-revalidate=${staleWhileRevalidate}`,
  ].join(', ')
  
  response.headers.set('Cache-Control', cacheControl)
  
  return response
}

/**
 * 添加 CORS 头
 */
export function withCors(
  response: NextResponse,
  options: {
    origin?: string
    methods?: string[]
    headers?: string[]
  } = {}
): NextResponse {
  const {
    origin = '*',
    methods = ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    headers = ['Content-Type', 'Authorization'],
  } = options
  
  response.headers.set('Access-Control-Allow-Origin', origin)
  response.headers.set('Access-Control-Allow-Methods', methods.join(', '))
  response.headers.set('Access-Control-Allow-Headers', headers.join(', '))
  
  return response
}

// ============================================
// 导出所有错误相关类型
// ============================================

export { ApiError, ErrorCode, type ErrorCodeType } from './errors'
