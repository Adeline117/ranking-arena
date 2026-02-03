/**
 * 日期格式化工具 - 统一处理多语言日期显示
 */

import type { Language } from '../i18n'

/**
 * 获取日期格式化的 locale
 */
export function getDateLocale(language: Language): string {
  return language === 'zh' ? 'zh-CN' : 'en-US'
}

/**
 * 格式化日期（短格式）
 */
export function formatDate(
  date: Date | string,
  language: Language,
  options?: Intl.DateTimeFormatOptions
): string {
  const d = typeof date === 'string' ? new Date(date) : date
  const defaultOptions: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }
  return d.toLocaleDateString(getDateLocale(language), options || defaultOptions)
}

/**
 * 格式化日期时间
 */
export function formatDateTime(
  date: Date | string,
  language: Language,
  options?: Intl.DateTimeFormatOptions
): string {
  const d = typeof date === 'string' ? new Date(date) : date
  const defaultOptions: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }
  return d.toLocaleString(getDateLocale(language), options || defaultOptions)
}

/**
 * 格式化相对时间（如"3分钟前"）
 */
export function formatRelativeTime(
  date: Date | string,
  language: Language
): string {
  const d = typeof date === 'string' ? new Date(date) : date
  const now = new Date()
  const diffMs = now.getTime() - d.getTime()
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

  // 超过一周显示具体日期
  return formatDate(d, language)
}

/**
 * 格式化时间（仅时间部分）
 */
export function formatTime(
  date: Date | string,
  language: Language
): string {
  const d = typeof date === 'string' ? new Date(date) : date
  return d.toLocaleTimeString(getDateLocale(language), {
    hour: '2-digit',
    minute: '2-digit',
  })
}
