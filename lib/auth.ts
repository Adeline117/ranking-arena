/**
 * 客户端认证工具
 * 提供统一的 auth token 获取、刷新和错误处理
 *
 * Token refresh is delegated to the centralized TokenRefreshCoordinator
 * for thundering herd prevention across all code paths.
 */

import { supabase } from '@/lib/supabase/client'
import { tokenRefreshCoordinator } from '@/lib/auth/token-refresh'

/**
 * 消息发送失败原因枚举
 */
export enum MessageErrorCode {
  NOT_AUTHENTICATED = 'NOT_AUTHENTICATED',
  TOKEN_EXPIRED = 'TOKEN_EXPIRED',
  PERMISSION_DENIED = 'PERMISSION_DENIED',
  NETWORK_ERROR = 'NETWORK_ERROR',
  SERVER_ERROR = 'SERVER_ERROR',
  RATE_LIMITED = 'RATE_LIMITED',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
}

/**
 * 错误码对应的用户友好提示
 */
export const ERROR_MESSAGES: Record<MessageErrorCode, string> = {
  [MessageErrorCode.NOT_AUTHENTICATED]: '请先登录',
  [MessageErrorCode.TOKEN_EXPIRED]: '登录已过期，正在刷新...',
  [MessageErrorCode.PERMISSION_DENIED]: '无权发送私信',
  [MessageErrorCode.NETWORK_ERROR]: '网络异常，请检查连接',
  [MessageErrorCode.SERVER_ERROR]: '服务异常，请稍后重试',
  [MessageErrorCode.RATE_LIMITED]: '操作过于频繁，请稍后重试',
  [MessageErrorCode.VALIDATION_ERROR]: '消息格式错误',
}

/**
 * Auth 结果类型
 */
export type AuthResult = {
  userId: string
  accessToken: string
} | null

/**
 * 获取当前有效的 auth session
 * Delegates to the centralized TokenRefreshCoordinator which handles
 * proactive expiry detection and thundering herd prevention.
 * @returns AuthResult 或 null（未登录时）
 */
export async function getAuthSession(): Promise<AuthResult> {
  try {
    // Use coordinator for proactive refresh (refreshes if token expires within 60s)
    const token = await tokenRefreshCoordinator.getValidToken()
    if (!token) return null

    // Get user info from current session
    const { data: { session } } = await supabase.auth.getSession()
    if (!session?.user) return null

    return {
      userId: session.user.id,
      accessToken: token,
    }
  } catch (err) {
    console.warn('[auth] getAuthSession failed:', err instanceof Error ? err.message : err)
    return null
  }
}

/**
 * 刷新 auth token
 * Delegates to the centralized coordinator for thundering herd prevention.
 * @returns 新的 AuthResult 或 null
 */
export async function refreshAuthToken(): Promise<AuthResult> {
  try {
    const token = await tokenRefreshCoordinator.forceRefresh()
    if (!token) return null

    const { data: { session } } = await supabase.auth.getSession()
    if (!session?.user) return null

    return {
      userId: session.user.id,
      accessToken: token,
    }
  } catch (err) {
    console.warn('[auth] refreshAuthToken failed:', err instanceof Error ? err.message : err)
    return null
  }
}

/**
 * 获取 Authorization headers
 * @returns headers 对象，包含 Bearer token
 */
export async function getAuthHeaders(): Promise<Record<string, string>> {
  const auth = await getAuthSession()
  if (!auth) return {}
  return { Authorization: `Bearer ${auth.accessToken}` }
}

/**
 * 根据 HTTP 状态码和服务端响应确定错误码
 */
export function resolveErrorCode(
  status: number,
  responseData?: { error_code?: string; error?: string }
): MessageErrorCode {
  // 优先使用服务端返回的 error_code
  if (responseData?.error_code) {
    const code = responseData.error_code as MessageErrorCode
    if (Object.values(MessageErrorCode).includes(code)) {
      return code
    }
  }

  switch (status) {
    case 401:
      return MessageErrorCode.NOT_AUTHENTICATED
    case 403:
      return MessageErrorCode.PERMISSION_DENIED
    case 429:
      return MessageErrorCode.RATE_LIMITED
    default:
      if (status >= 500) return MessageErrorCode.SERVER_ERROR
      return MessageErrorCode.VALIDATION_ERROR
  }
}

/**
 * 获取错误的用户友好消息
 * 优先使用服务端返回的具体消息，如果没有则使用错误码对应的默认消息
 */
export function getErrorMessage(
  errorCode: MessageErrorCode,
  serverMessage?: string
): string {
  // 对于权限错误，优先使用服务端返回的具体原因
  if (errorCode === MessageErrorCode.PERMISSION_DENIED && serverMessage) {
    return serverMessage
  }
  return ERROR_MESSAGES[errorCode] || '发送失败'
}
