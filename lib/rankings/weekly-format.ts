import { getLocaleFromLanguage } from '@/lib/utils/format'

const WEEK_WINDOW_DAYS = 7

export function formatWeeklyRoi(value: number): string {
  const sign = value > 0 ? '+' : ''
  if (Math.abs(value) >= 10_000) {
    const compact = new Intl.NumberFormat('en-US', {
      notation: 'compact',
      maximumFractionDigits: 1,
    }).format(value)
    return `${sign}${compact}%`
  }
  return `${sign}${value.toLocaleString('en-US', { maximumFractionDigits: 2 })}%`
}

export function formatWeeklyMoney(value: number, currency: string): string {
  const sign = value > 0 ? '+' : ''
  const compact = new Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value)
  return `${sign}${compact} ${currency}`
}

export function formatWeeklyWinRate(value: number | null): string {
  if (value === null) return '—'
  return `${value.toLocaleString('en-US', { maximumFractionDigits: 1 })}%`
}

/**
 * Format the seven-day window in UTC so server and browser render the same
 * calendar dates even when the snapshot is near midnight.
 */
export function formatWeeklyRange(asOf: string | null, language: string): string | null {
  if (!asOf) return null
  const end = new Date(asOf)
  if (Number.isNaN(end.getTime())) return null

  const start = new Date(end.getTime() - (WEEK_WINDOW_DAYS - 1) * 24 * 60 * 60 * 1000)
  const formatter = new Intl.DateTimeFormat(getLocaleFromLanguage(language), {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })
  return `${formatter.format(start)} – ${formatter.format(end)}`
}
