const DISPLAY_LOCALE = 'en-US'

export function formatExchangePercent(value: number | null, signed = false): string {
  if (value === null) return '—'
  const sign = signed && value > 0 ? '+' : ''
  return `${sign}${value.toLocaleString(DISPLAY_LOCALE, { maximumFractionDigits: 1 })}%`
}

export function formatExchangeMoney(value: number, currency: string): string {
  const sign = value > 0 ? '+' : ''
  const compact = new Intl.NumberFormat(DISPLAY_LOCALE, {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value)
  return `${sign}${compact} ${currency}`
}

export function formatExchangeTraderCount(value: number): string {
  return value.toLocaleString(DISPLAY_LOCALE)
}
