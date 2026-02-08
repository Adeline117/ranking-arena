/**
 * 集中式错误处理工具
 * 提供错误分类、日志记录、Toast 通知等功能
 */

import { parseError, type ParsedError, type ErrorType } from './error-messages'

// ── 错误日志 ──────────────────────────────────────────────

interface ErrorContext {
  /** 错误发生的模块或页面 */
  source?: string
  /** 用户操作描述 */
  action?: string
  /** 额外上下文数据 */
  meta?: Record<string, unknown>
}

/**
 * 带上下文的错误日志记录
 * 在开发环境下输出详细堆栈，生产环境下精简输出
 */
export function logError(error: unknown, context?: ErrorContext): ParsedError {
  const parsed = parseError(error)
  const isDev = process.env.NODE_ENV === 'development'

  const label = context?.source ? `[${context.source}]` : '[Error]'
  const actionInfo = context?.action ? ` (${context.action})` : ''

  if (isDev) {
    console.group(`${label}${actionInfo} ${parsed.type}`)
    console.error('原始错误:', error)
    console.log('解析结果:', parsed)
    if (context?.meta) {
      console.log('上下文:', context.meta)
    }
    console.groupEnd()
  } else {
    console.error(`${label}${actionInfo}`, parsed.type, parsed.message)
  }

  return parsed
}

// ── Toast 通知 ─────────────────────────────────────────────

type ToastFn = (message: string, type: 'success' | 'error' | 'warning' | 'info') => void

let _toastFn: ToastFn | null = null

/**
 * 注册全局 Toast 函数（由 Toast Provider 调用）
 */
export function registerToast(fn: ToastFn) {
  _toastFn = fn
}

/**
 * 将 API 错误以 Toast 形式通知用户
 * 自动根据错误类型选择合适的 Toast 级别
 */
export function toastError(error: unknown, context?: ErrorContext): ParsedError {
  const parsed = logError(error, context)

  if (_toastFn) {
    const level = getToastLevel(parsed.type)
    _toastFn(parsed.message, level)
  }

  return parsed
}

/**
 * 根据错误类型映射 Toast 级别
 */
function getToastLevel(type: ErrorType): 'error' | 'warning' | 'info' {
  switch (type) {
    case 'network':
    case 'timeout':
    case 'service_unavailable':
      return 'warning'
    case 'rate_limit':
      return 'info'
    default:
      return 'error'
  }
}

// ── 安全执行 ──────────────────────────────────────────────

/**
 * 安全执行异步操作，捕获错误并返回结果
 */
export async function trySafe<T>(
  fn: () => Promise<T>,
  context?: ErrorContext,
): Promise<{ data: T; error: null } | { data: null; error: ParsedError }> {
  try {
    const data = await fn()
    return { data, error: null }
  } catch (err) {
    const parsed = logError(err, context)
    return { data: null, error: parsed }
  }
}

/**
 * 安全执行异步操作，失败时显示 Toast 并返回 null
 */
export async function trySafeWithToast<T>(
  fn: () => Promise<T>,
  context?: ErrorContext,
): Promise<T | null> {
  try {
    return await fn()
  } catch (err) {
    toastError(err, context)
    return null
  }
}

// ── 重新导出常用类型和函数 ──────────────────────────────────

export { parseError, getErrorMessage, isRetryableError, isAuthError } from './error-messages'
export type { ParsedError, ErrorType } from './error-messages'
