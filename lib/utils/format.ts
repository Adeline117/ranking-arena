/** Unified null/missing data display symbol. Use instead of 'N/A', '--', or '-'. */
export const NULL_DISPLAY = '—'

export function formatNumber(num: number | string | null | undefined, decimals = 0, locale?: string): string {
  if (num === null || num === undefined) return NULL_DISPLAY
  const n = typeof num === 'string' ? parseFloat(num) : num
  if (!Number.isFinite(n)) return NULL_DISPLAY

  return n.toLocaleString(locale || 'en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
}

/**
 * Format a value as a percentage.
 * Supports both positional args (legacy) and options object (preferred):
 *   formatPercent(0.12, 2, true)  → "+12.00%"  (legacy)
 *   formatPercent(0.12, { showSign: false })  → "12.00%"  (new)
 */
export function formatPercent(
  value: number | string | null | undefined,
  decimalsOrOptions?: number | { decimals?: number; multiply?: boolean; showSign?: boolean },
  multiply?: boolean
): string {
  if (value === null || value === undefined) return NULL_DISPLAY
  const n = typeof value === 'string' ? parseFloat(value) : value
  if (!Number.isFinite(n)) return NULL_DISPLAY

  let decimals = 2
  let mult = true
  let showSign = true

  if (typeof decimalsOrOptions === 'object' && decimalsOrOptions !== null) {
    decimals = decimalsOrOptions.decimals ?? 2
    mult = decimalsOrOptions.multiply ?? true
    showSign = decimalsOrOptions.showSign ?? true
  } else {
    if (typeof decimalsOrOptions === 'number') decimals = decimalsOrOptions
    if (typeof multiply === 'boolean') mult = multiply
  }

  const percent = mult ? n * 100 : n
  const sign = showSign && percent > 0 ? '+' : ''

  return `${sign}${percent.toFixed(decimals)}%`
}

export function formatCurrency(
  amount: number | string | null | undefined,
  currency = '$',
  decimals = 2,
  locale?: string
): string {
  if (amount === null || amount === undefined) return NULL_DISPLAY
  const n = typeof amount === 'string' ? parseFloat(amount) : amount
  if (!Number.isFinite(n)) return NULL_DISPLAY

  return `${currency}${formatNumber(n, decimals, locale)}`
}

/** Format large numbers compactly. CJK locales use 万/億 notation; others use K/M/B. */
export function formatCompact(num: number | string | null | undefined, decimals = 2, locale?: string): string {
  if (num === null || num === undefined) return NULL_DISPLAY
  const n = typeof num === 'string' ? parseFloat(num) : num
  if (!Number.isFinite(n)) return NULL_DISPLAY

  const abs = Math.abs(n)
  const sign = n < 0 ? '-' : ''

  // CJK locales: 万 (10K) / 億 (100M)
  if (locale === 'zh' || locale === 'ja') {
    const yi = locale === 'zh' ? '亿' : '億'
    if (abs >= 1e8) return `${sign}${(abs / 1e8).toFixed(decimals)}${yi}`
    if (abs >= 1e4) return `${sign}${(abs / 1e4).toFixed(decimals)}万`
    return `${sign}${abs.toFixed(decimals)}`
  }
  if (locale === 'ko') {
    if (abs >= 1e8) return `${sign}${(abs / 1e8).toFixed(decimals)}억`
    if (abs >= 1e4) return `${sign}${(abs / 1e4).toFixed(decimals)}만`
    return `${sign}${abs.toFixed(decimals)}`
  }

  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(decimals)}B`
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(decimals)}M`
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(decimals)}K`

  return `${sign}${abs.toFixed(decimals)}`
}

/**
 * Get the locale string for formatting based on the app language.
 * Use with formatNumber/formatCurrency for locale-aware number formatting.
 */
export function getLocaleFromLanguage(language: string): string {
  const map: Record<string, string> = { zh: 'zh-CN', ja: 'ja-JP', ko: 'ko-KR' }
  return map[language] || 'en-US'
}

/**
 * Format a date string for display, respecting the user's language.
 */
export function formatDateLocalized(
  dateStr: string | Date | null | undefined,
  language: string,
  options?: Intl.DateTimeFormatOptions
): string {
  if (!dateStr) return NULL_DISPLAY
  const date = typeof dateStr === 'string' ? new Date(dateStr) : dateStr
  if (isNaN(date.getTime())) return NULL_DISPLAY
  const locale = getLocaleFromLanguage(language)
  const defaultOptions: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }
  return date.toLocaleDateString(locale, options || defaultOptions)
}

export function truncate(text: string, maxLength: number, suffix = '...'): string {
  if (!text || text.length <= maxLength) return text || ''
  return text.slice(0, maxLength - suffix.length) + suffix
}

export function capitalize(text: string): string {
  if (!text) return ''
  return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase()
}
