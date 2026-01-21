/**
 * 安全输入验证模块
 * 提供 XSS 防护、SQL 注入防护和安全验证工具
 */

import { z } from 'zod'
import DOMPurify from 'isomorphic-dompurify'

// ============================================
// XSS 防护
// ============================================

/**
 * 清理 HTML 内容，防止 XSS 攻击
 */
export function sanitizeHtml(
  html: string,
  options: {
    /** 允许的 HTML 标签 */
    allowedTags?: string[]
    /** 允许的属性 */
    allowedAttributes?: Record<string, string[]>
    /** 是否允许链接 */
    allowLinks?: boolean
    /** 是否允许图片 */
    allowImages?: boolean
  } = {}
): string {
  const {
    allowedTags = ['p', 'br', 'b', 'i', 'u', 'strong', 'em', 'ul', 'ol', 'li', 'span'],
    allowedAttributes = {},
    allowLinks = true,
    allowImages = false,
  } = options

  const tags = [...allowedTags]
  const attrs = { ...allowedAttributes }

  if (allowLinks) {
    tags.push('a')
    attrs['a'] = ['href', 'target', 'rel']
  }

  if (allowImages) {
    tags.push('img')
    attrs['img'] = ['src', 'alt', 'width', 'height']
  }

  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: tags,
    ALLOWED_ATTR: Object.values(attrs).flat(),
    ALLOW_DATA_ATTR: false,
    ALLOW_UNKNOWN_PROTOCOLS: false,
  })
}

/**
 * 移除所有 HTML 标签，只保留纯文本
 */
export function stripHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [],
    ALLOWED_ATTR: [],
  })
}

/**
 * 转义 HTML 特殊字符
 */
export function escapeHtml(str: string): string {
  const htmlEscapes: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }
  return str.replace(/[&<>"']/g, (char) => htmlEscapes[char] || char)
}

// ============================================
// SQL 注入防护
// ============================================

/**
 * 检测潜在的 SQL 注入模式
 */
export function detectSqlInjection(input: string): boolean {
  const sqlPatterns = [
    /(\b(SELECT|INSERT|UPDATE|DELETE|DROP|UNION|ALTER|CREATE|TRUNCATE)\b)/i,
    /(--|\/\*|\*\/)/,
    /(\bOR\b\s+\d+\s*=\s*\d+)/i,
    /(\bAND\b\s+\d+\s*=\s*\d+)/i,
    /('\s*(OR|AND)\s*'?\d+'\s*=\s*'\d+)/i,
    /(;\s*(SELECT|INSERT|UPDATE|DELETE|DROP))/i,
    /(\bEXEC\b|\bEXECUTE\b)/i,
    /(\bxp_\w+)/i,
  ]

  return sqlPatterns.some((pattern) => pattern.test(input))
}

/**
 * 清理可能包含 SQL 注入的输入
 * 注意：这不是防止 SQL 注入的主要手段，应该使用参数化查询
 */
export function sanitizeSqlInput(input: string): string {
  return input
    .replace(/'/g, "''") // 转义单引号
    .replace(/\\/g, '\\\\') // 转义反斜杠
    .replace(/\x00/g, '') // 移除 NULL 字节
}

// ============================================
// 通用安全验证
// ============================================

/**
 * 验证并清理用户输入的文本
 */
export function sanitizeUserInput(
  input: string,
  options: {
    maxLength?: number
    allowNewlines?: boolean
    trim?: boolean
  } = {}
): string {
  const { maxLength = 10000, allowNewlines = true, trim = true } = options

  let result = input

  // 移除 NULL 字节和控制字符
  result = result.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')

  // 处理换行符
  if (!allowNewlines) {
    result = result.replace(/[\r\n]/g, ' ')
  }

  // 标准化 Unicode
  result = result.normalize('NFC')

  // 修剪空白
  if (trim) {
    result = result.trim()
  }

  // 限制长度
  if (result.length > maxLength) {
    result = result.slice(0, maxLength)
  }

  return result
}

/**
 * 验证邮箱格式
 */
export function isValidEmail(email: string): boolean {
  // RFC 5322 简化版正则
  const emailRegex = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/
  return emailRegex.test(email) && email.length <= 254
}

/**
 * 验证 URL 格式和安全性
 */
export function isValidUrl(url: string, options: {
  allowedProtocols?: string[]
  allowLocalhost?: boolean
} = {}): boolean {
  const { allowedProtocols = ['https'], allowLocalhost = false } = options

  try {
    const parsed = new URL(url)
    
    // 检查协议
    const protocol = parsed.protocol.replace(':', '')
    if (!allowedProtocols.includes(protocol)) {
      return false
    }

    // 检查是否是本地地址
    if (!allowLocalhost) {
      const hostname = parsed.hostname.toLowerCase()
      if (
        hostname === 'localhost' ||
        hostname === '127.0.0.1' ||
        hostname === '0.0.0.0' ||
        hostname.startsWith('192.168.') ||
        hostname.startsWith('10.') ||
        hostname.startsWith('172.') ||
        hostname === '::1'
      ) {
        return false
      }
    }

    return true
  } catch {
    return false
  }
}

/**
 * 验证用户名格式
 */
export function isValidUsername(username: string): { valid: boolean; error?: string } {
  if (username.length < 3) {
    return { valid: false, error: '用户名至少需要3个字符' }
  }
  if (username.length > 30) {
    return { valid: false, error: '用户名不能超过30个字符' }
  }
  if (!/^[a-zA-Z0-9_\u4e00-\u9fa5]+$/.test(username)) {
    return { valid: false, error: '用户名只能包含字母、数字、下划线和中文' }
  }
  if (/^[0-9_]/.test(username)) {
    return { valid: false, error: '用户名不能以数字或下划线开头' }
  }
  
  // 检查敏感词
  const reservedWords = ['admin', 'administrator', 'root', 'system', 'support', 'official', 'mod', 'moderator']
  if (reservedWords.includes(username.toLowerCase())) {
    return { valid: false, error: '该用户名已被保留' }
  }

  return { valid: true }
}

/**
 * 验证密码强度
 */
export function validatePasswordStrength(password: string): {
  valid: boolean
  score: number
  errors: string[]
} {
  const errors: string[] = []
  let score = 0

  if (password.length < 8) {
    errors.push('密码至少需要8个字符')
  } else {
    score += 1
  }

  if (password.length >= 12) {
    score += 1
  }

  if (/[a-z]/.test(password)) {
    score += 1
  } else {
    errors.push('密码需要包含小写字母')
  }

  if (/[A-Z]/.test(password)) {
    score += 1
  } else {
    errors.push('密码需要包含大写字母')
  }

  if (/[0-9]/.test(password)) {
    score += 1
  } else {
    errors.push('密码需要包含数字')
  }

  if (/[!@#$%^&*(),.?":{}|<>]/.test(password)) {
    score += 1
  }

  // 检查常见弱密码
  const weakPasswords = ['password', '123456', 'qwerty', 'abc123', 'password123']
  if (weakPasswords.includes(password.toLowerCase())) {
    errors.push('密码太常见，请使用更复杂的密码')
    score = 0
  }

  return {
    valid: errors.length === 0,
    score: Math.min(score, 5),
    errors,
  }
}

// ============================================
// Zod 安全增强 Schemas
// ============================================

/**
 * 安全字符串 Schema（自动清理）
 */
export const SafeStringSchema = z.string().transform((val) => sanitizeUserInput(val))

/**
 * 安全 HTML Schema（允许部分标签）
 */
export const SafeHtmlSchema = z.string().transform((val) => sanitizeHtml(val))

/**
 * 纯文本 Schema（移除所有 HTML）
 */
export const PlainTextSchema = z.string().transform((val) => stripHtml(val))

/**
 * 安全邮箱 Schema
 */
export const SafeEmailSchema = z
  .string()
  .email('邮箱格式无效')
  .max(254, '邮箱长度过长')
  .transform((val) => val.toLowerCase().trim())
  .refine((val) => isValidEmail(val), '邮箱格式无效')

/**
 * 安全 URL Schema
 */
export const SafeUrlSchema = z
  .string()
  .url('URL 格式无效')
  .refine((val) => isValidUrl(val), 'URL 不安全或格式无效')

/**
 * 安全用户名 Schema
 */
export const SafeUsernameSchema = z
  .string()
  .transform((val) => val.trim())
  .refine((val) => {
    const result = isValidUsername(val)
    return result.valid
  }, {
    message: '用户名格式无效',
  })

/**
 * 安全密码 Schema
 */
export const SafePasswordSchema = z
  .string()
  .min(8, '密码至少需要8个字符')
  .max(128, '密码不能超过128个字符')
  .refine((val) => {
    const result = validatePasswordStrength(val)
    return result.valid
  }, {
    message: '密码强度不足',
  })

/**
 * 防 SQL 注入的字符串 Schema
 */
export const SqlSafeStringSchema = z
  .string()
  .refine((val) => !detectSqlInjection(val), '输入包含不允许的字符')

// ============================================
// 创建验证中间件辅助函数
// ============================================

/**
 * 创建带安全清理的 Schema
 */
export function withSanitization<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess((val) => {
    if (typeof val === 'string') {
      return sanitizeUserInput(val)
    }
    if (typeof val === 'object' && val !== null) {
      return Object.fromEntries(
        Object.entries(val).map(([key, value]) => [
          key,
          typeof value === 'string' ? sanitizeUserInput(value) : value,
        ])
      )
    }
    return val
  }, schema)
}

/**
 * 验证并清理请求数据
 */
export async function validateAndSanitize<T extends z.ZodTypeAny>(
  schema: T,
  data: unknown
): Promise<z.infer<T>> {
  // 预处理：递归清理所有字符串
  const sanitized = deepSanitize(data)
  return schema.parse(sanitized)
}

/**
 * 深度清理对象中的所有字符串
 */
function deepSanitize(obj: unknown): unknown {
  if (typeof obj === 'string') {
    return sanitizeUserInput(obj)
  }
  if (Array.isArray(obj)) {
    return obj.map(deepSanitize)
  }
  if (typeof obj === 'object' && obj !== null) {
    return Object.fromEntries(
      Object.entries(obj).map(([key, value]) => [key, deepSanitize(value)])
    )
  }
  return obj
}

// ============================================
// 导出类型
// ============================================

export type SafeString = z.infer<typeof SafeStringSchema>
export type SafeEmail = z.infer<typeof SafeEmailSchema>
export type SafeUrl = z.infer<typeof SafeUrlSchema>
export type SafeUsername = z.infer<typeof SafeUsernameSchema>
export type SafePassword = z.infer<typeof SafePasswordSchema>
