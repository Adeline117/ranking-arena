/**
 * API 请求日志中间件
 * 记录请求耗时、状态码、错误信息等
 */

import { NextRequest, NextResponse } from 'next/server'
import { 
  generateRequestId, 
  setCurrentRequestId, 
  clearCurrentRequestId,
  logRequest,
  createTimer,
  createLogger
} from '@/lib/utils/logger'

const logger = createLogger('API')

export interface RequestContext {
  requestId: string
  startTime: number
  method: string
  path: string
  searchParams: URLSearchParams
}

/**
 * 创建请求上下文
 */
export function createRequestContext(request: NextRequest): RequestContext {
  const requestId = generateRequestId()
  setCurrentRequestId(requestId)
  
  return {
    requestId,
    startTime: Date.now(),
    method: request.method,
    path: request.nextUrl.pathname,
    searchParams: request.nextUrl.searchParams,
  }
}

/**
 * 记录请求完成
 */
export function logRequestComplete(
  context: RequestContext,
  response: NextResponse,
  error?: Error
): void {
  const duration = Date.now() - context.startTime
  
  logRequest({
    method: context.method,
    path: context.path,
    statusCode: response.status,
    duration,
    error: error?.message,
  })
  
  clearCurrentRequestId()
}

/**
 * 包装 API 处理函数，自动添加日志
 */
export function withLogging<T extends NextRequest>(
  handler: (request: T, context: RequestContext) => Promise<NextResponse>
) {
  return async (request: T): Promise<NextResponse> => {
    const ctx = createRequestContext(request)
    const timer = createTimer(`${ctx.method} ${ctx.path}`, 'API')
    
    try {
      const response = await handler(request, ctx)
      
      // 添加请求 ID 到响应头
      response.headers.set('X-Request-ID', ctx.requestId)
      
      timer.end({ status: response.status })
      logRequestComplete(ctx, response)
      
      return response
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error))

      logger.errorWithException(`Request failed: ${ctx.method} ${ctx.path}`, err, {
        requestId: ctx.requestId,
      })
      
      const errorResponse = NextResponse.json(
        { 
          error: 'Internal server error',
          requestId: ctx.requestId,
        },
        { status: 500 }
      )
      
      errorResponse.headers.set('X-Request-ID', ctx.requestId)
      
      timer.end({ status: 500, error: err.message })
      logRequestComplete(ctx, errorResponse, err)
      
      return errorResponse
    }
  }
}

/**
 * 简化版包装器（用于不需要完整上下文的场景）
 */
export function withSimpleLogging(
  handler: (request: NextRequest) => Promise<NextResponse>
) {
  return async (request: NextRequest): Promise<NextResponse> => {
    const method = request.method
    const path = request.nextUrl.pathname
    const timer = createTimer(`${method} ${path}`, 'API')
    
    try {
      const response = await handler(request)
      timer.end({ status: response.status })
      return response
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error))
      logger.errorWithException(`Request failed: ${method} ${path}`, err)
      timer.end({ status: 500, error: err.message })
      
      return NextResponse.json(
        { error: 'Internal server error' },
        { status: 500 }
      )
    }
  }
}

/**
 * 性能监控装饰器
 */
export function measurePerformance(name: string) {
  return function <T extends (...args: unknown[]) => Promise<unknown>>(
    target: T
  ): T {
    return (async (...args: unknown[]) => {
      const timer = createTimer(name, 'Performance')
      try {
        const result = await target(...args)
        timer.end()
        return result
      } catch (error) {
        timer.end({ error: String(error) })
        throw error
      }
    }) as T
  }
}
