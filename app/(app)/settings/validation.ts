/**
 * Settings Page Validation Functions
 */

import {
  getHandleShapeError,
  isReservedHandle,
  MAX_HANDLE_LENGTH as HANDLE_MAX_LENGTH,
} from '@/lib/identity/handle-policy'

export const MAX_BIO_LENGTH = 200
export const MAX_HANDLE_LENGTH = HANDLE_MAX_LENGTH

export interface ValidationResult {
  valid: boolean
  message: string
}

type TranslationFn = (key: string) => string

const fallback: TranslationFn = (key: string) => {
  const map: Record<string, string> = {
    validationHandleMinLength: 'Username must be at least 1 character',
    validationHandleMaxLength: `Username cannot exceed ${MAX_HANDLE_LENGTH} characters`,
    validationHandleInvalidChars:
      'Username can only contain English letters, numbers, underscores, Chinese, Japanese, and Korean characters',
    usernameInUse: 'This username is reserved or already in use',
    validationInvalidEmail: 'Please enter a valid email address',
    validationPasswordMinLength: 'Password must be at least 6 characters',
    validationPasswordMismatch: 'Passwords do not match',
  }
  return map[key] ?? key
}

export function validateHandle(
  handle: string,
  t: TranslationFn = fallback,
  initialHandle: string | null = null
): ValidationResult {
  const unchanged = initialHandle !== null && handle === initialHandle
  const shapeError = getHandleShapeError(handle, {
    allowUnchangedLegacyDot: unchanged,
  })

  if (shapeError === 'required') {
    return { valid: false, message: t('validationHandleMinLength') }
  }
  if (shapeError === 'too_long') {
    return {
      valid: false,
      message: t('validationHandleMaxLength').replace('{max}', String(MAX_HANDLE_LENGTH)),
    }
  }
  if (shapeError !== null) {
    return { valid: false, message: t('validationHandleInvalidChars') }
  }

  // The database trigger exempts only a byte-for-byte unchanged legacy value
  // from the new-handle dot/reserved checks.
  if (unchanged) return { valid: true, message: '' }

  if (isReservedHandle(handle)) {
    return { valid: false, message: t('usernameInUse') }
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
