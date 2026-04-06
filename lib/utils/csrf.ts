/**
 * CSRF 保护工具
 * 使用双重提交 Cookie 模式实现 CSRF 防护
 * 使用 Web Crypto API 以支持 Edge Runtime
 */

// CSRF Token 配置
const CSRF_TOKEN_LENGTH = 32
const CSRF_COOKIE_NAME = 'csrf-token'
const CSRF_HEADER_NAME = 'x-csrf-token'
const CSRF_TOKEN_EXPIRY = 24 * 60 * 60 * 1000 // 24 小时

/**
 * 生成随机字节并转为 hex 字符串
 * 使用 Web Crypto API 以支持 Edge Runtime
 */
function randomHex(length: number): string {
  const array = new Uint8Array(length)
  crypto.getRandomValues(array)
  return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * 生成 CSRF Token
 */
export function generateCsrfToken(): string {
  return randomHex(CSRF_TOKEN_LENGTH)
}

/**
 * 生成带时间戳的 CSRF Token
 */
export function generateTimedCsrfToken(): string {
  const timestamp = Date.now().toString(36)
  const token = randomHex(CSRF_TOKEN_LENGTH)
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
  } catch (_err) {
    /* timestamp parse failed */
    return false
  }
}

/**
 * 比较两个 token 是否相等（使用时间安全的比较）
 * 使用恒定时间比较防止时序攻击
 */
export function safeCompare(a: string, b: string): boolean {
  if (!a || !b) return false
  if (a.length !== b.length) return false

  // 恒定时间比较
  let result = 0
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return result === 0
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
