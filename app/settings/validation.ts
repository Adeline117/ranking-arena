/**
 * Settings Page Validation Functions
 * 提取自 settings/page.tsx 以便测试
 */

export const MAX_BIO_LENGTH = 200
export const MAX_HANDLE_LENGTH = 30

export interface ValidationResult {
  valid: boolean
  message: string
}

/**
 * 验证用户名
 * - 至少 2 个字符
 * - 最多 30 个字符
 * - 只能包含字母、数字、下划线和中文
 */
export function validateHandle(handle: string): ValidationResult {
  if (!handle) return { valid: true, message: '' }

  if (handle.length < 2) {
    return { valid: false, message: '用户名至少需要2个字符' }
  }

  if (handle.length > MAX_HANDLE_LENGTH) {
    return { valid: false, message: `用户名不能超过${MAX_HANDLE_LENGTH}个字符` }
  }

  if (!/^[a-zA-Z0-9_\u4e00-\u9fa5]+$/.test(handle)) {
    return { valid: false, message: '用户名只能包含字母、数字、下划线和中文' }
  }

  return { valid: true, message: '' }
}

/**
 * 验证邮箱格式
 */
export function validateEmail(email: string): ValidationResult {
  if (!email) return { valid: true, message: '' }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  if (!emailRegex.test(email)) {
    return { valid: false, message: '请输入有效的邮箱地址' }
  }

  return { valid: true, message: '' }
}

/**
 * 验证密码
 * - 至少 6 个字符
 */
export function validatePassword(password: string): ValidationResult {
  if (!password) return { valid: true, message: '' }

  if (password.length < 6) {
    return { valid: false, message: '密码至少需要6个字符' }
  }

  return { valid: true, message: '' }
}

/**
 * 验证密码确认
 */
export function validatePasswordMatch(
  password: string,
  confirmPassword: string
): ValidationResult {
  if (!confirmPassword) return { valid: true, message: '' }

  if (password !== confirmPassword) {
    return { valid: false, message: '两次输入的密码不一致' }
  }

  return { valid: true, message: '' }
}
