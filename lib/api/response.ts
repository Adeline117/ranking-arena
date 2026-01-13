/**
 * API 响应辅助函数
 */

import { NextResponse } from 'next/server'

export interface ApiSuccessResponse<T = unknown> {
  success: true
  data: T
  pagination?: {
    limit: number
    offset: number
    has_more: boolean
    total?: number
  }
}

export interface ApiErrorResponse {
  success: false
  error: string
  code?: string
}

export type ApiResponse<T = unknown> = ApiSuccessResponse<T> | ApiErrorResponse

/**
 * 成功响应
 */
export function success<T>(data: T, status = 200): NextResponse<ApiSuccessResponse<T>> {
  return NextResponse.json(
    { success: true as const, data },
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
    { success: true as const, data, pagination },
    { status }
  )
}

/**
 * 错误响应
 */
export function error(message: string, status = 400, code?: string): NextResponse<ApiErrorResponse> {
  return NextResponse.json(
    { success: false as const, error: message, ...(code ? { code } : {}) },
    { status }
  )
}

/**
 * 未授权响应
 */
export function unauthorized(message = '未授权'): NextResponse<ApiErrorResponse> {
  return error(message, 401, 'UNAUTHORIZED')
}

/**
 * 禁止访问响应
 */
export function forbidden(message = '禁止访问'): NextResponse<ApiErrorResponse> {
  return error(message, 403, 'FORBIDDEN')
}

/**
 * 未找到响应
 */
export function notFound(message = '未找到'): NextResponse<ApiErrorResponse> {
  return error(message, 404, 'NOT_FOUND')
}

/**
 * 服务器错误响应
 */
export function serverError(message = '服务器错误'): NextResponse<ApiErrorResponse> {
  return error(message, 500, 'SERVER_ERROR')
}

/**
 * 参数验证错误响应
 */
export function validationError(message: string): NextResponse<ApiErrorResponse> {
  return error(message, 400, 'VALIDATION_ERROR')
}

/**
 * 处理异常并返回适当的响应
 */
export function handleError(err: unknown, context?: string): NextResponse<ApiErrorResponse> {
  // 处理各种错误类型：Error 实例、Supabase 错误对象、普通对象、字符串等
  let errorMessage: string
  if (err instanceof Error) {
    errorMessage = err.message
  } else if (typeof err === 'object' && err !== null && 'message' in err) {
    // Supabase 错误等带有 message 属性的对象
    errorMessage = String((err as { message: unknown }).message)
  } else if (typeof err === 'string') {
    errorMessage = err
  } else {
    errorMessage = '未知错误'
  }
  const statusCode = (err as any)?.statusCode || (err as any)?.status || 500
  
  if (context) {
    console.error(`[${context}] 错误:`, err)
  }
  
  // 如果是已知的业务错误（有 statusCode），使用该状态码
  if (statusCode === 401) {
    return unauthorized(errorMessage)
  }
  if (statusCode === 403) {
    return forbidden(errorMessage)
  }
  if (statusCode === 404) {
    return notFound(errorMessage)
  }
  if (statusCode < 500) {
    return error(errorMessage, statusCode)
  }
  
  // 生产环境不暴露详细错误信息
  const isProduction = process.env.NODE_ENV === 'production'
  return serverError(isProduction ? '服务器错误，请稍后重试' : errorMessage)
}

