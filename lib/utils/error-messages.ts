/**
 * 统一错误提示信息
 * 提供用户友好的错误消息，支持国际化
 */

// 错误代码枚举
export enum ErrorCode {
  // 网络错误
  NETWORK_ERROR = 'NETWORK_ERROR',
  TIMEOUT = 'TIMEOUT',
  SERVER_ERROR = 'SERVER_ERROR',
  
  // 认证错误
  AUTH_REQUIRED = 'AUTH_REQUIRED',
  SESSION_EXPIRED = 'SESSION_EXPIRED',
  INVALID_CREDENTIALS = 'INVALID_CREDENTIALS',
  
  // 权限错误
  PERMISSION_DENIED = 'PERMISSION_DENIED',
  FORBIDDEN = 'FORBIDDEN',
  
  // 资源错误
  NOT_FOUND = 'NOT_FOUND',
  ALREADY_EXISTS = 'ALREADY_EXISTS',
  
  // 限流错误
  RATE_LIMITED = 'RATE_LIMITED',
  TOO_MANY_REQUESTS = 'TOO_MANY_REQUESTS',
  
  // 验证错误
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  INVALID_INPUT = 'INVALID_INPUT',
  
  // 业务错误
  OPERATION_FAILED = 'OPERATION_FAILED',
  INSUFFICIENT_BALANCE = 'INSUFFICIENT_BALANCE',
  
  // 未知错误
  UNKNOWN_ERROR = 'UNKNOWN_ERROR',
}

// 错误消息映射
export const ErrorMessages: Record<ErrorCode, { zh: string; en: string }> = {
  // 网络错误
  [ErrorCode.NETWORK_ERROR]: {
    zh: '网络连接失败，请检查网络后重试',
    en: 'Network error, please check your connection',
  },
  [ErrorCode.TIMEOUT]: {
    zh: '请求超时，请稍后重试',
    en: 'Request timeout, please try again later',
  },
  [ErrorCode.SERVER_ERROR]: {
    zh: '服务器错误，请稍后重试',
    en: 'Server error, please try again later',
  },
  
  // 认证错误
  [ErrorCode.AUTH_REQUIRED]: {
    zh: '请先登录后再进行此操作',
    en: 'Please login to continue',
  },
  [ErrorCode.SESSION_EXPIRED]: {
    zh: '登录已过期，请重新登录',
    en: 'Session expired, please login again',
  },
  [ErrorCode.INVALID_CREDENTIALS]: {
    zh: '用户名或密码错误',
    en: 'Invalid username or password',
  },
  
  // 权限错误
  [ErrorCode.PERMISSION_DENIED]: {
    zh: '您没有权限执行此操作',
    en: 'Permission denied',
  },
  [ErrorCode.FORBIDDEN]: {
    zh: '访问被拒绝',
    en: 'Access forbidden',
  },
  
  // 资源错误
  [ErrorCode.NOT_FOUND]: {
    zh: '未找到相关内容',
    en: 'Content not found',
  },
  [ErrorCode.ALREADY_EXISTS]: {
    zh: '该内容已存在',
    en: 'Content already exists',
  },
  
  // 限流错误
  [ErrorCode.RATE_LIMITED]: {
    zh: '操作过于频繁，请稍后再试',
    en: 'Too many requests, please slow down',
  },
  [ErrorCode.TOO_MANY_REQUESTS]: {
    zh: '请求次数超过限制，请稍后再试',
    en: 'Rate limit exceeded',
  },
  
  // 验证错误
  [ErrorCode.VALIDATION_ERROR]: {
    zh: '输入数据格式不正确',
    en: 'Invalid input format',
  },
  [ErrorCode.INVALID_INPUT]: {
    zh: '请检查输入内容',
    en: 'Please check your input',
  },
  
  // 业务错误
  [ErrorCode.OPERATION_FAILED]: {
    zh: '操作失败，请重试',
    en: 'Operation failed, please retry',
  },
  [ErrorCode.INSUFFICIENT_BALANCE]: {
    zh: '余额不足',
    en: 'Insufficient balance',
  },
  
  // 未知错误
  [ErrorCode.UNKNOWN_ERROR]: {
    zh: '发生未知错误，请稍后重试',
    en: 'An unknown error occurred',
  },
}

/**
 * 获取错误消息
 */
export function getErrorMessage(
  code: ErrorCode | string,
  locale: 'zh' | 'en' = 'zh'
): string {
  const message = ErrorMessages[code as ErrorCode]
  if (message) {
    return message[locale]
  }
  return ErrorMessages[ErrorCode.UNKNOWN_ERROR][locale]
}

/**
 * 从 HTTP 状态码获取错误代码
 */
export function getErrorCodeFromStatus(status: number): ErrorCode {
  switch (status) {
    case 400:
      return ErrorCode.VALIDATION_ERROR
    case 401:
      return ErrorCode.AUTH_REQUIRED
    case 403:
      return ErrorCode.FORBIDDEN
    case 404:
      return ErrorCode.NOT_FOUND
    case 408:
      return ErrorCode.TIMEOUT
    case 409:
      return ErrorCode.ALREADY_EXISTS
    case 429:
      return ErrorCode.RATE_LIMITED
    case 500:
    case 502:
    case 503:
    case 504:
      return ErrorCode.SERVER_ERROR
    default:
      return ErrorCode.UNKNOWN_ERROR
  }
}

/**
 * 从错误对象解析错误信息
 */
export function parseError(
  error: unknown,
  locale: 'zh' | 'en' = 'zh'
): { code: ErrorCode; message: string } {
  // 已知错误类型
  if (error instanceof Error) {
    // 检查是否是网络错误
    if (error.name === 'TypeError' && error.message.includes('fetch')) {
      return {
        code: ErrorCode.NETWORK_ERROR,
        message: getErrorMessage(ErrorCode.NETWORK_ERROR, locale),
      }
    }
    
    // 检查是否是超时错误
    if (error.name === 'AbortError' || error.message.includes('timeout')) {
      return {
        code: ErrorCode.TIMEOUT,
        message: getErrorMessage(ErrorCode.TIMEOUT, locale),
      }
    }
  }
  
  // 检查是否是带有 code 的错误对象
  if (typeof error === 'object' && error !== null) {
    const errObj = error as Record<string, unknown>
    
    if (errObj.code && typeof errObj.code === 'string') {
      return {
        code: errObj.code as ErrorCode,
        message: errObj.message as string || getErrorMessage(errObj.code as ErrorCode, locale),
      }
    }
    
    if (errObj.status && typeof errObj.status === 'number') {
      const code = getErrorCodeFromStatus(errObj.status)
      return {
        code,
        message: errObj.message as string || getErrorMessage(code, locale),
      }
    }
  }
  
  // 默认未知错误
  return {
    code: ErrorCode.UNKNOWN_ERROR,
    message: getErrorMessage(ErrorCode.UNKNOWN_ERROR, locale),
  }
}

/**
 * 创建用户友好的错误对象
 */
export class UserFriendlyError extends Error {
  code: ErrorCode
  userMessage: string
  
  constructor(code: ErrorCode, originalError?: Error) {
    super(originalError?.message || getErrorMessage(code, 'en'))
    this.name = 'UserFriendlyError'
    this.code = code
    this.userMessage = getErrorMessage(code, 'zh')
    
    // 保留原始错误堆栈
    if (originalError?.stack) {
      this.stack = originalError.stack
    }
  }
}

// 常用错误快捷方法
export const Errors = {
  authRequired: () => new UserFriendlyError(ErrorCode.AUTH_REQUIRED),
  networkError: () => new UserFriendlyError(ErrorCode.NETWORK_ERROR),
  notFound: () => new UserFriendlyError(ErrorCode.NOT_FOUND),
  rateLimited: () => new UserFriendlyError(ErrorCode.RATE_LIMITED),
  validationError: () => new UserFriendlyError(ErrorCode.VALIDATION_ERROR),
  serverError: () => new UserFriendlyError(ErrorCode.SERVER_ERROR),
}

