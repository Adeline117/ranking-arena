/**
 * Settings Page Validation Functions
 */

export const MAX_BIO_LENGTH = 200
export const MAX_HANDLE_LENGTH = 30

export interface ValidationResult {
  valid: boolean
  message: string
}

type TranslationFn = (key: string) => string

const fallback: TranslationFn = (key: string) => {
  const map: Record<string, string> = {
    validationHandleMinLength: 'Username must be at least 2 characters',
    validationHandleMaxLength: `Username cannot exceed ${MAX_HANDLE_LENGTH} characters`,
    validationHandleInvalidChars: 'Username can only contain letters, numbers, underscores, and Chinese characters',
    validationInvalidEmail: 'Please enter a valid email address',
    validationPasswordMinLength: 'Password must be at least 6 characters',
    validationPasswordMismatch: 'Passwords do not match',
  }
  return map[key] ?? key
}

export function validateHandle(handle: string, t: TranslationFn = fallback): ValidationResult {
  if (!handle) return { valid: true, message: '' }

  if (handle.length < 2) {
    return { valid: false, message: t('validationHandleMinLength') }
  }

  if (handle.length > MAX_HANDLE_LENGTH) {
    return { valid: false, message: t('validationHandleMaxLength').replace('{max}', String(MAX_HANDLE_LENGTH)) }
  }

  if (!/^[a-zA-Z0-9_\u4e00-\u9fa5]+$/.test(handle)) {
    return { valid: false, message: t('validationHandleInvalidChars') }
  }

  return { valid: true, message: '' }
}

export function validateEmail(email: string, t: TranslationFn = fallback): ValidationResult {
  if (!email) return { valid: true, message: '' }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  if (!emailRegex.test(email)) {
    return { valid: false, message: t('validationInvalidEmail') }
  }

  return { valid: true, message: '' }
}

export function validatePassword(password: string, t: TranslationFn = fallback): ValidationResult {
  if (!password) return { valid: true, message: '' }

  if (password.length < 6) {
    return { valid: false, message: t('validationPasswordMinLength') }
  }

  return { valid: true, message: '' }
}

export function validatePasswordMatch(
  password: string,
  confirmPassword: string,
  t: TranslationFn = fallback
): ValidationResult {
  if (!confirmPassword) return { valid: true, message: '' }

  if (password !== confirmPassword) {
    return { valid: false, message: t('validationPasswordMismatch') }
  }

  return { valid: true, message: '' }
}
