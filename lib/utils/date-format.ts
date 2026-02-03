/**
 * Date formatting utilities for multi-language date display
 */

import type { Language } from '../i18n'

/**
 * Convert date input to Date object
 */
function toDate(date: Date | string): Date {
  return typeof date === 'string' ? new Date(date) : date
}

/**
 * Get locale string for date formatting
 */
export function getDateLocale(language: Language): string {
  return language === 'zh' ? 'zh-CN' : 'en-US'
}

const DEFAULT_DATE_OPTIONS: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
}

const DEFAULT_DATETIME_OPTIONS: Intl.DateTimeFormatOptions = {
  ...DEFAULT_DATE_OPTIONS,
  hour: '2-digit',
  minute: '2-digit',
}

const DEFAULT_TIME_OPTIONS: Intl.DateTimeFormatOptions = {
  hour: '2-digit',
  minute: '2-digit',
}

/**
 * Format date (short format)
 */
export function formatDate(
  date: Date | string,
  language: Language,
  options?: Intl.DateTimeFormatOptions
): string {
  return toDate(date).toLocaleDateString(
    getDateLocale(language),
    options || DEFAULT_DATE_OPTIONS
  )
}

/**
 * Format date and time
 */
export function formatDateTime(
  date: Date | string,
  language: Language,
  options?: Intl.DateTimeFormatOptions
): string {
  return toDate(date).toLocaleString(
    getDateLocale(language),
    options || DEFAULT_DATETIME_OPTIONS
  )
}

/**
 * Format relative time (e.g., "3 minutes ago")
 */
export function formatRelativeTime(
  date: Date | string,
  language: Language
): string {
  const d = toDate(date)
  const diffMs = Date.now() - d.getTime()
  const diffSec = Math.floor(diffMs / 1000)
  const diffMin = Math.floor(diffSec / 60)
  const diffHour = Math.floor(diffMin / 60)
  const diffDay = Math.floor(diffHour / 24)

  const isZh = language === 'zh'

  if (diffSec < 60) {
    return isZh ? `${diffSec}秒前` : `${diffSec}s ago`
  }
  if (diffMin < 60) {
    return isZh ? `${diffMin}分钟前` : `${diffMin}m ago`
  }
  if (diffHour < 24) {
    return isZh ? `${diffHour}小时前` : `${diffHour}h ago`
  }
  if (diffDay < 7) {
    return isZh ? `${diffDay}天前` : `${diffDay}d ago`
  }

  return formatDate(d, language)
}

/**
 * Format time only
 */
export function formatTime(
  date: Date | string,
  language: Language
): string {
  return toDate(date).toLocaleTimeString(
    getDateLocale(language),
    DEFAULT_TIME_OPTIONS
  )
}
