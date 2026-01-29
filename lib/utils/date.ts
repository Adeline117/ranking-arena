export type Locale = 'zh' | 'en'

const translations = {
  zh: {
    justNow: '刚刚',
    minutesAgo: (n: number) => `${n}分钟前`,
    hoursAgo: (n: number) => `${n}小时前`,
    daysAgo: (n: number) => `${n}天前`,
    weeksAgo: (n: number) => `${n}周前`,
    monthsAgo: (n: number) => `${n}个月前`,
    yearsAgo: (n: number) => `${n}年前`,
  },
  en: {
    justNow: 'just now',
    minutesAgo: (n: number) => `${n} minute${n > 1 ? 's' : ''} ago`,
    hoursAgo: (n: number) => `${n} hour${n > 1 ? 's' : ''} ago`,
    daysAgo: (n: number) => `${n} day${n > 1 ? 's' : ''} ago`,
    weeksAgo: (n: number) => `${n} week${n > 1 ? 's' : ''} ago`,
    monthsAgo: (n: number) => `${n} month${n > 1 ? 's' : ''} ago`,
    yearsAgo: (n: number) => `${n} year${n > 1 ? 's' : ''} ago`,
  },
}

export function formatTimeAgo(dateString: string | Date, locale: Locale = 'zh'): string {
  // 处理无效输入
  if (!dateString) {
    return locale === 'zh' ? '未知时间' : 'unknown'
  }
  
  const date = typeof dateString === 'string' ? new Date(dateString) : dateString
  
  // 检查日期是否有效
  if (isNaN(date.getTime())) {
    return locale === 'zh' ? '未知时间' : 'unknown'
  }
  
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  
  const diffSeconds = Math.floor(diffMs / 1000)
  const diffMinutes = Math.floor(diffSeconds / 60)
  const diffHours = Math.floor(diffMinutes / 60)
  const diffDays = Math.floor(diffHours / 24)
  const diffWeeks = Math.floor(diffDays / 7)
  const diffMonths = Math.floor(diffDays / 30)
  const diffYears = Math.floor(diffDays / 365)
  
  const t = translations[locale]
  
  if (diffMinutes < 1) return t.justNow
  if (diffMinutes < 60) return t.minutesAgo(diffMinutes)
  if (diffHours < 24) return t.hoursAgo(diffHours)
  if (diffDays < 7) return t.daysAgo(diffDays)
  if (diffWeeks < 4) return t.weeksAgo(diffWeeks)
  if (diffMonths < 12) return t.monthsAgo(diffMonths)
  return t.yearsAgo(diffYears)
}

export function formatDate(
  dateString: string | Date,
  format: 'short' | 'long' | 'datetime' = 'short',
  locale: Locale = 'zh'
): string {
  const date = typeof dateString === 'string' ? new Date(dateString) : dateString
  const localeString = locale === 'zh' ? 'zh-CN' : 'en-US'
  
  switch (format) {
    case 'short':
      return date.toLocaleDateString(localeString)
    case 'long':
      return date.toLocaleDateString(localeString, {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      })
    case 'datetime':
      return date.toLocaleString(localeString, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    default:
      return date.toLocaleDateString(localeString)
  }
}

export function daysBetween(date1: Date | string, date2: Date | string): number {
  const d1 = typeof date1 === 'string' ? new Date(date1) : date1
  const d2 = typeof date2 === 'string' ? new Date(date2) : date2
  const diffMs = Math.abs(d2.getTime() - d1.getTime())
  return Math.floor(diffMs / (1000 * 60 * 60 * 24))
}

export function isWithinDays(date: Date | string, days: number): boolean {
  const d = typeof date === 'string' ? new Date(date) : date
  const now = new Date()
  return daysBetween(d, now) <= days
}

