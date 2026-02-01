/**
 * 统一 API 错误处理系统
 * 提供标准化的错误码和错误类
 */

// ============================================
// 错误码枚举
// ============================================

export const ErrorCode = {
  // 通用错误 (1xxx)
  UNKNOWN_ERROR: 'UNKNOWN_ERROR',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  
  // 认证错误 (2xxx)
  UNAUTHORIZED: 'UNAUTHORIZED',
  INVALID_TOKEN: 'INVALID_TOKEN',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  FORBIDDEN: 'FORBIDDEN',
  
  // 资源错误 (3xxx)
  NOT_FOUND: 'NOT_FOUND',
  RESOURCE_EXISTS: 'RESOURCE_EXISTS',
  RESOURCE_DELETED: 'RESOURCE_DELETED',
  
  // 验证错误 (4xxx)
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  INVALID_INPUT: 'INVALID_INPUT',
  MISSING_FIELD: 'MISSING_FIELD',
  INVALID_FORMAT: 'INVALID_FORMAT',
  VALUE_TOO_LONG: 'VALUE_TOO_LONG',
  VALUE_TOO_SHORT: 'VALUE_TOO_SHORT',
  VALUE_OUT_OF_RANGE: 'VALUE_OUT_OF_RANGE',
  
  // 业务错误 (5xxx)
  OPERATION_FAILED: 'OPERATION_FAILED',
  DUPLICATE_ACTION: 'DUPLICATE_ACTION',
  LIMIT_EXCEEDED: 'LIMIT_EXCEEDED',
  INSUFFICIENT_PERMISSION: 'INSUFFICIENT_PERMISSION',
  
  // 限流错误 (6xxx)
  RATE_LIMIT_EXCEEDED: 'RATE_LIMIT_EXCEEDED',
  TOO_MANY_REQUESTS: 'TOO_MANY_REQUESTS',
  
  // 外部服务错误 (7xxx)
  EXTERNAL_SERVICE_ERROR: 'EXTERNAL_SERVICE_ERROR',
  DATABASE_ERROR: 'DATABASE_ERROR',
  NETWORK_ERROR: 'NETWORK_ERROR',
  PROVIDER_RATE_LIMIT: 'PROVIDER_RATE_LIMIT',
  PROVIDER_ERROR: 'PROVIDER_ERROR',
} as const

export type ErrorCodeType = typeof ErrorCode[keyof typeof ErrorCode]

// ============================================
// 错误码到 HTTP 状态码映射
// ============================================

export const ErrorCodeToHttpStatus: Record<ErrorCodeType, number> = {
  // 通用错误
  [ErrorCode.UNKNOWN_ERROR]: 500,
  [ErrorCode.INTERNAL_ERROR]: 500,
  [ErrorCode.SERVICE_UNAVAILABLE]: 503,
  
  // 认证错误
  [ErrorCode.UNAUTHORIZED]: 401,
  [ErrorCode.INVALID_TOKEN]: 401,
  [ErrorCode.TOKEN_EXPIRED]: 401,
  [ErrorCode.FORBIDDEN]: 403,
  
  // 资源错误
  [ErrorCode.NOT_FOUND]: 404,
  [ErrorCode.RESOURCE_EXISTS]: 409,
  [ErrorCode.RESOURCE_DELETED]: 410,
  
  // 验证错误
  [ErrorCode.VALIDATION_ERROR]: 400,
  [ErrorCode.INVALID_INPUT]: 400,
  [ErrorCode.MISSING_FIELD]: 400,
  [ErrorCode.INVALID_FORMAT]: 400,
  [ErrorCode.VALUE_TOO_LONG]: 400,
  [ErrorCode.VALUE_TOO_SHORT]: 400,
  [ErrorCode.VALUE_OUT_OF_RANGE]: 400,
  
  // 业务错误
  [ErrorCode.OPERATION_FAILED]: 400,
  [ErrorCode.DUPLICATE_ACTION]: 409,
  [ErrorCode.LIMIT_EXCEEDED]: 400,
  [ErrorCode.INSUFFICIENT_PERMISSION]: 403,
  
  // 限流错误
  [ErrorCode.RATE_LIMIT_EXCEEDED]: 429,
  [ErrorCode.TOO_MANY_REQUESTS]: 429,
  
  // 外部服务错误
  [ErrorCode.EXTERNAL_SERVICE_ERROR]: 502,
  [ErrorCode.DATABASE_ERROR]: 500,
  [ErrorCode.NETWORK_ERROR]: 502,
  [ErrorCode.PROVIDER_RATE_LIMIT]: 429,
  [ErrorCode.PROVIDER_ERROR]: 502,
}

// ============================================
// 错误码到默认消息映射（中英文）
// ============================================

export const ErrorMessages: Record<ErrorCodeType, { zh: string; en: string }> = {
  // 通用错误
  [ErrorCode.UNKNOWN_ERROR]: { zh: 'Unknown error', en: 'Unknown error' },
  [ErrorCode.INTERNAL_ERROR]: { zh: '服务器内部错误', en: 'Internal server error' },
  [ErrorCode.SERVICE_UNAVAILABLE]: { zh: '服务暂时不可用', en: 'Service unavailable' },
  
  // 认证错误
  [ErrorCode.UNAUTHORIZED]: { zh: '未授权，请先登录', en: 'Unauthorized, please login' },
  [ErrorCode.INVALID_TOKEN]: { zh: '无效的认证令牌', en: 'Invalid authentication token' },
  [ErrorCode.TOKEN_EXPIRED]: { zh: '认证令牌已过期', en: 'Authentication token expired' },
  [ErrorCode.FORBIDDEN]: { zh: '没有权限执行此操作', en: 'Permission denied' },
  
  // 资源错误
  [ErrorCode.NOT_FOUND]: { zh: '资源不存在', en: 'Resource not found' },
  [ErrorCode.RESOURCE_EXISTS]: { zh: '资源已存在', en: 'Resource already exists' },
  [ErrorCode.RESOURCE_DELETED]: { zh: '资源已被删除', en: 'Resource has been deleted' },
  
  // 验证错误
  [ErrorCode.VALIDATION_ERROR]: { zh: '输入验证失败', en: 'Validation failed' },
  [ErrorCode.INVALID_INPUT]: { zh: '无效的输入', en: 'Invalid input' },
  [ErrorCode.MISSING_FIELD]: { zh: '缺少必填字段', en: 'Required field missing' },
  [ErrorCode.INVALID_FORMAT]: { zh: '格式不正确', en: 'Invalid format' },
  [ErrorCode.VALUE_TOO_LONG]: { zh: '值太长', en: 'Value too long' },
  [ErrorCode.VALUE_TOO_SHORT]: { zh: '值太短', en: 'Value too short' },
  [ErrorCode.VALUE_OUT_OF_RANGE]: { zh: '值超出范围', en: 'Value out of range' },
  
  // 业务错误
  [ErrorCode.OPERATION_FAILED]: { zh: '操作失败', en: 'Operation failed' },
  [ErrorCode.DUPLICATE_ACTION]: { zh: '重复操作', en: 'Duplicate action' },
  [ErrorCode.LIMIT_EXCEEDED]: { zh: '超出限制', en: 'Limit exceeded' },
  [ErrorCode.INSUFFICIENT_PERMISSION]: { zh: '权限不足', en: 'Insufficient permission' },
  
  // 限流错误
  [ErrorCode.RATE_LIMIT_EXCEEDED]: { zh: '请求过于频繁，请稍后再试', en: 'Rate limit exceeded, please try again later' },
  [ErrorCode.TOO_MANY_REQUESTS]: { zh: '请求次数过多', en: 'Too many requests' },
  
  // 外部服务错误
  [ErrorCode.EXTERNAL_SERVICE_ERROR]: { zh: '外部服务错误', en: 'External service error' },
  [ErrorCode.DATABASE_ERROR]: { zh: '数据库错误', en: 'Database error' },
  [ErrorCode.NETWORK_ERROR]: { zh: '网络错误', en: 'Network error' },
  [ErrorCode.PROVIDER_RATE_LIMIT]: { zh: '服务请求频率超限，请稍后再试', en: 'Provider rate limit exceeded, please try again later' },
  [ErrorCode.PROVIDER_ERROR]: { zh: '外部服务提供商错误', en: 'External provider error' },
}

// ============================================
// API 错误类
// ============================================

export interface ApiErrorOptions {
  code?: ErrorCodeType
  statusCode?: number
  details?: Record<string, unknown>
  cause?: Error
}

export class ApiError extends Error {
  readonly code: ErrorCodeType
  readonly statusCode: number
  readonly details?: Record<string, unknown>
  readonly cause?: Error
  readonly timestamp: string

  constructor(message: string, options: ApiErrorOptions = {}) {
    super(message)
    this.name = 'ApiError'
    this.code = options.code || ErrorCode.UNKNOWN_ERROR
    this.statusCode = options.statusCode || ErrorCodeToHttpStatus[this.code] || 500
    this.details = options.details
    this.cause = options.cause
    this.timestamp = new Date().toISOString()

    // 捕获堆栈追踪
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, ApiError)
    }
  }

  /**
   * 转换为 JSON 响应格式
   */
  toJSON(): {
    success: false
    error: {
      code: string
      message: string
      details?: Record<string, unknown>
      timestamp: string
    }
  } {
    return {
      success: false,
      error: {
        code: this.code,
        message: this.message,
        ...(this.details && { details: this.details }),
        timestamp: this.timestamp,
      },
    }
  }

  /**
   * 静态工厂方法：未授权错误
   */
  static unauthorized(message?: string): ApiError {
    return new ApiError(message || ErrorMessages[ErrorCode.UNAUTHORIZED].en, {
      code: ErrorCode.UNAUTHORIZED,
    })
  }

  /**
   * 静态工厂方法：禁止访问错误
   */
  static forbidden(message?: string): ApiError {
    return new ApiError(message || ErrorMessages[ErrorCode.FORBIDDEN].en, {
      code: ErrorCode.FORBIDDEN,
    })
  }

  /**
   * 静态工厂方法：未找到错误
   */
  static notFound(message?: string): ApiError {
    return new ApiError(message || ErrorMessages[ErrorCode.NOT_FOUND].en, {
      code: ErrorCode.NOT_FOUND,
    })
  }

  /**
   * 静态工厂方法：验证错误
   */
  static validation(message: string, details?: Record<string, unknown>): ApiError {
    return new ApiError(message, {
      code: ErrorCode.VALIDATION_ERROR,
      details,
    })
  }

  /**
   * 静态工厂方法：限流错误
   */
  static rateLimitExceeded(retryAfter?: number): ApiError {
    return new ApiError(ErrorMessages[ErrorCode.RATE_LIMIT_EXCEEDED].en, {
      code: ErrorCode.RATE_LIMIT_EXCEEDED,
      details: retryAfter ? { retryAfter } : undefined,
    })
  }

  /**
   * 静态工厂方法：数据库错误
   */
  static database(message?: string, cause?: Error): ApiError {
    return new ApiError(message || ErrorMessages[ErrorCode.DATABASE_ERROR].en, {
      code: ErrorCode.DATABASE_ERROR,
      cause,
    })
  }

  /**
   * 静态工厂方法：内部错误
   */
  static internal(message?: string, cause?: Error): ApiError {
    return new ApiError(message || ErrorMessages[ErrorCode.INTERNAL_ERROR].en, {
      code: ErrorCode.INTERNAL_ERROR,
      cause,
    })
  }

  /**
   * 静态工厂方法：提供商限流错误
   */
  static providerRateLimit(retryAfter?: number, providerName?: string): ApiError {
    const message = providerName
      ? `${providerName} rate limit exceeded, please try again later`
      : ErrorMessages[ErrorCode.PROVIDER_RATE_LIMIT].en
    return new ApiError(message, {
      code: ErrorCode.PROVIDER_RATE_LIMIT,
      details: {
        retryAfter,
        provider: providerName,
        retryable: true,
      },
    })
  }

  /**
   * 静态工厂方法：提供商错误
   */
  static providerError(message?: string, cause?: Error, retryable = false): ApiError {
    return new ApiError(message || ErrorMessages[ErrorCode.PROVIDER_ERROR].en, {
      code: ErrorCode.PROVIDER_ERROR,
      cause,
      details: { retryable },
    })
  }

  /**
   * 从未知错误创建 ApiError
   */
  static from(error: unknown, _context?: string): ApiError {
    // 如果已经是 ApiError，直接返回
    if (error instanceof ApiError) {
      return error
    }

    // 如果是标准 Error
    if (error instanceof Error) {
      const statusCode = (error as Error & { statusCode?: number }).statusCode
      const code = (error as Error & { code?: string }).code as ErrorCodeType | undefined

      // 注意：这里不直接使用 logger，因为 errors.ts 可能被 logger 本身使用
      // 如果需要日志，应该在调用 ApiError.from 的地方记录

      return new ApiError(error.message, {
        code: code || ErrorCode.INTERNAL_ERROR,
        statusCode: statusCode || 500,
        cause: error,
      })
    }

    // 如果是对象
    if (typeof error === 'object' && error !== null) {
      const errorObj = error as Record<string, unknown>
      const message = String(errorObj.message || errorObj.error || 'Unknown error')
      const statusCode = typeof errorObj.statusCode === 'number' ? errorObj.statusCode : 500
      const code = (errorObj.code as ErrorCodeType) || ErrorCode.UNKNOWN_ERROR

      // 注意：这里不直接使用 logger，因为 errors.ts 可能被 logger 本身使用
      // 如果需要日志，应该在调用 ApiError.from 的地方记录

      return new ApiError(message, { code, statusCode })
    }

    // 其他情况
    const message = typeof error === 'string' ? error : 'Unknown error'
    // 注意：这里不直接使用 logger，因为 errors.ts 可能被 logger 本身使用
    // 如果需要日志，应该在调用 ApiError.from 的地方记录

    return new ApiError(message, { code: ErrorCode.UNKNOWN_ERROR })
  }
}

// ============================================
// HTTP 状态码到错误码映射
// ============================================

export function httpStatusToErrorCode(status: number): ErrorCodeType {
  switch (status) {
    case 400:
      return ErrorCode.VALIDATION_ERROR
    case 401:
      return ErrorCode.UNAUTHORIZED
    case 403:
      return ErrorCode.FORBIDDEN
    case 404:
      return ErrorCode.NOT_FOUND
    case 409:
      return ErrorCode.RESOURCE_EXISTS
    case 410:
      return ErrorCode.RESOURCE_DELETED
    case 429:
      return ErrorCode.RATE_LIMIT_EXCEEDED
    case 500:
      return ErrorCode.INTERNAL_ERROR
    case 502:
      return ErrorCode.EXTERNAL_SERVICE_ERROR
    case 503:
      return ErrorCode.SERVICE_UNAVAILABLE
    default:
      return status >= 500 ? ErrorCode.INTERNAL_ERROR : ErrorCode.UNKNOWN_ERROR
  }
}
