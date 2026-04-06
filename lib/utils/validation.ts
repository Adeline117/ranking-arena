import type { Locale } from './date'

export type ValidationResult = {
  valid: boolean
  message: string
}

export const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
export const HANDLE_REGEX = /^[a-zA-Z0-9_\u4e00-\u9fa5]+$/

const VALID_RESULT: ValidationResult = { valid: true, message: '' }

function msg(locale: Locale) {
  return (locale === 'ja' || locale === 'ko') ? messages.en : messages[locale as 'zh' | 'en']
}

const messages = {
  zh: {
    invalidEmail: '请输入有效的邮箱地址',
    passwordTooShort: (min: number) => `密码至少需要${min}个字符`,
    passwordMismatch: '两次输入的密码不一致',
    handleTooShort: (min: number) => `用户名至少需要${min}个字符`,
    handleTooLong: (max: number) => `用户名不能超过${max}个字符`,
    handleInvalidChars: '用户名只能包含字母、数字、下划线和中文',
    invalidUrl: '请输入有效的URL地址',
    required: (field: string) => `请输入${field}`,
    tooLong: (field: string, max: number) => `${field}不能超过${max}个字符`,
    tooShort: (field: string, min: number) => `${field}至少需要${min}个字符`,
  },
  en: {
    invalidEmail: 'Please enter a valid email address',
    passwordTooShort: (min: number) => `Password must be at least ${min} characters`,
    passwordMismatch: 'Passwords do not match',
    handleTooShort: (min: number) => `Username must be at least ${min} characters`,
    handleTooLong: (max: number) => `Username cannot exceed ${max} characters`,
    handleInvalidChars: 'Username can only contain letters, numbers, underscores and Chinese characters',
    invalidUrl: 'Please enter a valid URL',
    required: (field: string) => `Please enter ${field}`,
    tooLong: (field: string, max: number) => `${field} cannot exceed ${max} characters`,
    tooShort: (field: string, min: number) => `${field} must be at least ${min} characters`,
  },
}

function invalid(message: string): ValidationResult {
  return { valid: false, message }
}

/**
 * 验证邮箱格式
 */
export function validateEmail(email: string, locale: Locale = 'zh'): ValidationResult {
  if (!email) return VALID_RESULT
  if (!EMAIL_REGEX.test(email)) return invalid(msg(locale).invalidEmail)
  return VALID_RESULT
}


/**
 * 验证密码强度
 */
export function validatePassword(password: string, minLength = 6, locale: Locale = 'zh'): ValidationResult {
  if (!password) return VALID_RESULT
  if (password.length < minLength) return invalid(msg(locale).passwordTooShort(minLength))
  return VALID_RESULT
}


/**
 * 验证两次密码是否匹配
 */
export function validatePasswordMatch(password: string, confirmPassword: string, locale: Locale = 'zh'): ValidationResult {
  if (!confirmPassword) return VALID_RESULT
  if (password !== confirmPassword) return invalid(msg(locale).passwordMismatch)
  return VALID_RESULT
}


/**
 * 验证用户名格式
 */
export function validateHandle(handle: string, minLength = 1, locale: Locale = 'zh'): ValidationResult {
  if (!handle) return VALID_RESULT
  if (handle.length < minLength) return invalid(msg(locale).handleTooShort(minLength))
  if (handle.length > 30) return invalid(msg(locale).handleTooLong(30))
  if (!HANDLE_REGEX.test(handle)) return invalid(msg(locale).handleInvalidChars)
  return VALID_RESULT
}


/**
 * 计算密码强度
 */
export function getPasswordStrength(password: string): {
  level: 0 | 1 | 2 | 3 | 4
  label: string
  labelEn: string
  color: string
} {
  if (!password) return { level: 0, label: '', labelEn: '', color: '' }
  
  let score = 0
  if (password.length >= 6) score++
  if (password.length >= 8) score++
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score++
  if (/\d/.test(password)) score++
  if (/[^a-zA-Z0-9]/.test(password)) score++
  
  if (score <= 1) return { level: 1, label: '弱', labelEn: 'Weak', color: 'var(--color-accent-error)' }
  if (score === 2) return { level: 2, label: '一般', labelEn: 'Fair', color: 'var(--color-medal-gold-end)' }
  if (score === 3) return { level: 3, label: '中等', labelEn: 'Good', color: 'var(--color-accent-warning)' }
  return { level: 4, label: '强', labelEn: 'Strong', color: 'var(--color-accent-success)' }
}

/**
 * 验证 URL 格式
 */
export function validateUrl(url: string, locale: Locale = 'zh'): ValidationResult {
  if (!url) return VALID_RESULT
  try {
    new URL(url)
    return VALID_RESULT
  } catch (_err) {
    /* invalid URL format */
    return invalid(msg(locale).invalidUrl)
  }
}

/**
 * 验证必填字段
 */
export function validateRequired(value: string, fieldName: string, locale: Locale = 'zh'): ValidationResult {
  if (!value || !value.trim()) return invalid(msg(locale).required(fieldName))
  return VALID_RESULT
}

/**
 * 验证字符长度范围
 */
export function validateLength(
  value: string,
  fieldName: string,
  options: { min?: number; max?: number },
  locale: Locale = 'zh'
): ValidationResult {
  if (!value) return VALID_RESULT
  if (options.min && value.length < options.min) return invalid(msg(locale).tooShort(fieldName, options.min))
  if (options.max && value.length > options.max) return invalid(msg(locale).tooLong(fieldName, options.max))
  return VALID_RESULT
}

