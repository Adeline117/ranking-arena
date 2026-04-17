export type Locale = 'en' | 'zh' | 'ja' | 'ko'

const translations: Record<Locale, {
  justNow: string
  minutesAgo: (n: number) => string
  hoursAgo: (n: number) => string
  daysAgo: (n: number) => string
  weeksAgo: (n: number) => string
  monthsAgo: (n: number) => string
  yearsAgo: (n: number) => string
}> = {
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
  ja: {
    justNow: 'たった今',
    minutesAgo: (n: number) => `${n}分前`,
    hoursAgo: (n: number) => `${n}時間前`,
    daysAgo: (n: number) => `${n}日前`,
    weeksAgo: (n: number) => `${n}週間前`,
    monthsAgo: (n: number) => `${n}ヶ月前`,
    yearsAgo: (n: number) => `${n}年前`,
  },
  ko: {
    justNow: '방금',
    minutesAgo: (n: number) => `${n}분 전`,
    hoursAgo: (n: number) => `${n}시간 전`,
    daysAgo: (n: number) => `${n}일 전`,
    weeksAgo: (n: number) => `${n}주 전`,
    monthsAgo: (n: number) => `${n}개월 전`,
    yearsAgo: (n: number) => `${n}년 전`,
  },
}

export function formatTimeAgo(dateString: string | Date, locale: Locale = 'zh'): string {
  const effectiveLocale = locale
  // 处理无效输入
  if (!dateString) {
    return effectiveLocale === 'zh' ? '未知时间' : effectiveLocale === 'ja' ? '不明' : effectiveLocale === 'ko' ? '알 수 없음' : 'unknown'
  }

  const date = typeof dateString === 'string' ? new Date(dateString) : dateString

  if (isNaN(date.getTime())) {
    return effectiveLocale === 'zh' ? '未知时间' : effectiveLocale === 'ja' ? '不明' : effectiveLocale === 'ko' ? '알 수 없음' : 'unknown'
  }
  
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()

  // Guard: negative diff means future date (clock skew, bad data) — treat as "just now"
  if (diffMs < 0 || !Number.isFinite(diffMs)) {
    return translations[effectiveLocale].justNow
  }

  const diffSeconds = Math.floor(diffMs / 1000)
  const diffMinutes = Math.floor(diffSeconds / 60)
  const diffHours = Math.floor(diffMinutes / 60)
  const diffDays = Math.floor(diffHours / 24)
  const diffWeeks = Math.floor(diffDays / 7)
  const diffMonths = Math.floor(diffDays / 30)
  const diffYears = Math.floor(diffDays / 365)

  const t = translations[effectiveLocale]

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
  const localeMap: Record<Locale, string> = { en: 'en-US', zh: 'zh-CN', ja: 'ja-JP', ko: 'ko-KR' }
  const localeString = localeMap[locale] || 'en-US'
  
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

/**
 * Get today's date as a UTC YYYY-MM-DD string.
 * Use this instead of `new Date().toISOString().split('T')[0]` to avoid
 * timezone-related off-by-one issues.
 */
export function getTodayUTC(): string {
  const now = new Date()
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`
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

/**
 * Truncate an ISO timestamp to the hour boundary.
 * The partitioned trader_snapshots_v2 table has as_of_ts in its unique constraint.
 * Without truncation, every upsert creates a new row instead of updating.
 */
export function truncateToHour(isoOrDate?: string | Date | null): string {
  const d = isoOrDate ? new Date(isoOrDate) : new Date()
  d.setUTCMinutes(0, 0, 0)
  return d.toISOString()
}

