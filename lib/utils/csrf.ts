/**
 * CSRF 保护工具
 * 使用双重提交 Cookie 模式实现 CSRF 防护
 */

import crypto from 'crypto'

// CSRF Token 配置
const CSRF_TOKEN_LENGTH = 32
const CSRF_COOKIE_NAME = 'csrf-token'
const CSRF_HEADER_NAME = 'x-csrf-token'
const CSRF_TOKEN_EXPIRY = 24 * 60 * 60 * 1000 // 24 小时

/**
 * 生成 CSRF Token
 */
export function generateCsrfToken(): string {
  return crypto.randomBytes(CSRF_TOKEN_LENGTH).toString('hex')
}

/**
 * 生成带时间戳的 CSRF Token
 */
export function generateTimedCsrfToken(): string {
  const timestamp = Date.now().toString(36)
  const token = crypto.randomBytes(CSRF_TOKEN_LENGTH).toString('hex')
  return `${timestamp}.${token}`
}

/**
 * 验证带时间戳的 CSRF Token
 */
export function validateTimedCsrfToken(token: string): boolean {
  if (!token) return false
  
  const parts = token.split('.')
  if (parts.length !== 2) return false
  
  const [timestampStr, tokenPart] = parts
  
  // 验证 token 部分长度
  if (tokenPart.length !== CSRF_TOKEN_LENGTH * 2) return false
  
  // 验证时间戳
  try {
    const timestamp = parseInt(timestampStr, 36)
    const now = Date.now()
    
    // Token 已过期
    if (now - timestamp > CSRF_TOKEN_EXPIRY) {
      return false
    }
    
    return true
  } catch {
    return false
  }
}

/**
 * 比较两个 token 是否相等（使用时间安全的比较）
 */
export function safeCompare(a: string, b: string): boolean {
  if (!a || !b) return false
  if (a.length !== b.length) return false
  
  try {
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b))
  } catch {
    return false
  }
}

/**
 * 验证 CSRF Token
 * 比较 cookie 中的 token 和 header 中的 token
 */
export function validateCsrfToken(
  cookieToken: string | undefined,
  headerToken: string | undefined
): boolean {
  if (!cookieToken || !headerToken) {
    return false
  }
  
  // 验证 token 格式和时间
  if (!validateTimedCsrfToken(cookieToken) || !validateTimedCsrfToken(headerToken)) {
    return false
  }
  
  // 比较两个 token
  return safeCompare(cookieToken, headerToken)
}

/**
 * 获取 CSRF Cookie 配置
 */
export function getCsrfCookieOptions() {
  const isProduction = process.env.NODE_ENV === 'production'
  
  return {
    name: CSRF_COOKIE_NAME,
    httpOnly: false, // 需要 JavaScript 读取
    secure: isProduction,
    sameSite: 'strict' as const,
    path: '/',
    maxAge: CSRF_TOKEN_EXPIRY / 1000, // 秒
  }
}

// 导出常量
export {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  CSRF_TOKEN_EXPIRY,
}
