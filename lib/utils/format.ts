export function formatNumber(num: number | string, decimals = 0): string {
  const n = typeof num === 'string' ? parseFloat(num) : num
  if (isNaN(n)) return '0'

  return n.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
}

/**
 * Format a decimal value as a percentage (e.g. 0.1234 -> "+12.34%").
 * Set multiply=false if the value is already in percent form.
 */
export function formatPercent(value: number | string, decimals = 2, multiply = true): string {
  const n = typeof value === 'string' ? parseFloat(value) : value
  if (isNaN(n)) return '0%'

  const percent = multiply ? n * 100 : n
  const sign = percent >= 0 ? '+' : ''

  return `${sign}${percent.toFixed(decimals)}%`
}

export function formatCurrency(
  amount: number | string,
  currency = '$',
  decimals = 2
): string {
  const n = typeof amount === 'string' ? parseFloat(amount) : amount
  if (isNaN(n)) return `${currency}0`

  return `${currency}${formatNumber(n, decimals)}`
}

/** Format large numbers compactly (e.g. 1200 -> "1.2K", 3400000 -> "3.4M"). */
export function formatCompact(num: number | string, decimals = 1): string {
  const n = typeof num === 'string' ? parseFloat(num) : num
  if (isNaN(n)) return '0'

  const abs = Math.abs(n)
  const sign = n < 0 ? '-' : ''

  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(decimals)}B`
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(decimals)}M`
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(decimals)}K`

  return `${sign}${Math.round(abs)}`
}

export function truncate(text: string, maxLength: number, suffix = '...'): string {
  if (!text || text.length <= maxLength) return text || ''
  return text.slice(0, maxLength - suffix.length) + suffix
}

export function capitalize(text: string): string {
  if (!text) return ''
  return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase()
}
