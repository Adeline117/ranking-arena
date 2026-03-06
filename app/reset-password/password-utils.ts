import { tokens } from '@/lib/design-tokens'

export type PasswordStrength = {
  level: 0 | 1 | 2 | 3 | 4
  labelKey: string
  color: string
}

// Password strength indicator
export function getPasswordStrength(password: string): PasswordStrength {
  if (!password) return { level: 0, labelKey: '', color: '' }

  let score = 0
  if (password.length >= 6) score++
  if (password.length >= 8) score++
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score++
  if (/\d/.test(password)) score++
  if (/[^a-zA-Z0-9]/.test(password)) score++

  if (score <= 1) return { level: 1, labelKey: 'loginPasswordWeak', color: tokens.colors.accent.error }
  if (score === 2) return { level: 2, labelKey: 'loginPasswordFair', color: tokens.colors.accent.warning }
  if (score === 3) return { level: 3, labelKey: 'loginPasswordGood', color: tokens.colors.accent.warning }
  return { level: 4, labelKey: 'loginPasswordStrong', color: tokens.colors.accent.success }
}
