/**
 * 通用验证工具函数
 */

export type ValidationResult = {
  valid: boolean
  message: string
}

// 邮箱格式正则表达式
export const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// 用户名允许的字符正则表达式（字母、数字、下划线、中文）
export const HANDLE_REGEX = /^[a-zA-Z0-9_\u4e00-\u9fa5]+$/

/**
 * 验证邮箱格式
 */
export function validateEmail(email: string): ValidationResult {
  if (!email) return { valid: true, message: '' }
  if (!EMAIL_REGEX.test(email)) {
    return { valid: false, message: '请输入有效的邮箱地址' }
  }
  return { valid: true, message: '' }
}

/**
 * 验证邮箱格式（英文消息）
 */
export function validateEmailEn(email: string): ValidationResult {
  if (!email) return { valid: true, message: '' }
  if (!EMAIL_REGEX.test(email)) {
    return { valid: false, message: 'Please enter a valid email address' }
  }
  return { valid: true, message: '' }
}

/**
 * 验证密码强度
 */
export function validatePassword(password: string, minLength = 6): ValidationResult {
  if (!password) return { valid: true, message: '' }
  if (password.length < minLength) {
    return { valid: false, message: `密码至少需要${minLength}个字符` }
  }
  return { valid: true, message: '' }
}

/**
 * 验证密码强度（英文消息）
 */
export function validatePasswordEn(password: string, minLength = 6): ValidationResult {
  if (!password) return { valid: true, message: '' }
  if (password.length < minLength) {
    return { valid: false, message: `Password must be at least ${minLength} characters` }
  }
  return { valid: true, message: '' }
}

/**
 * 验证两次密码是否匹配
 */
export function validatePasswordMatch(password: string, confirmPassword: string): ValidationResult {
  if (!confirmPassword) return { valid: true, message: '' }
  if (password !== confirmPassword) {
    return { valid: false, message: '两次输入的密码不一致' }
  }
  return { valid: true, message: '' }
}

/**
 * 验证两次密码是否匹配（英文消息）
 */
export function validatePasswordMatchEn(password: string, confirmPassword: string): ValidationResult {
  if (!confirmPassword) return { valid: true, message: '' }
  if (password !== confirmPassword) {
    return { valid: false, message: 'Passwords do not match' }
  }
  return { valid: true, message: '' }
}

/**
 * 验证用户名格式
 */
export function validateHandle(handle: string, minLength = 1): ValidationResult {
  if (!handle) return { valid: true, message: '' }
  if (handle.length < minLength) {
    return { valid: false, message: `用户名至少需要${minLength}个字符` }
  }
  if (!HANDLE_REGEX.test(handle)) {
    return { valid: false, message: '用户名只能包含字母、数字、下划线和中文' }
  }
  return { valid: true, message: '' }
}

/**
 * 验证用户名格式（英文消息）
 */
export function validateHandleEn(handle: string, minLength = 1): ValidationResult {
  if (!handle) return { valid: true, message: '' }
  if (handle.length < minLength) {
    return { valid: false, message: `Username must be at least ${minLength} characters` }
  }
  if (!HANDLE_REGEX.test(handle)) {
    return { valid: false, message: 'Username can only contain letters, numbers, underscores and Chinese characters' }
  }
  return { valid: true, message: '' }
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
  
  if (score <= 1) return { level: 1, label: '弱', labelEn: 'Weak', color: '#ff4d4d' }
  if (score === 2) return { level: 2, label: '一般', labelEn: 'Fair', color: '#ffa500' }
  if (score === 3) return { level: 3, label: '中等', labelEn: 'Good', color: '#ffc107' }
  return { level: 4, label: '强', labelEn: 'Strong', color: '#2fe57d' }
}

/**
 * 验证 URL 格式
 */
export function validateUrl(url: string): ValidationResult {
  if (!url) return { valid: true, message: '' }
  try {
    new URL(url)
    return { valid: true, message: '' }
  } catch {
    return { valid: false, message: '请输入有效的URL地址' }
  }
}

