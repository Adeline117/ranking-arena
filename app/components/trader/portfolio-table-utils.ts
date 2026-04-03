import { tokens } from '@/lib/design-tokens'
import { NULL_DISPLAY } from '@/lib/utils/format'
import type { PositionHistoryItem } from '@/lib/data/trader'

// Extended position history type
export interface ExtendedPositionHistoryItem extends PositionHistoryItem {
  positionType?: string
  marginMode?: string
  maxPositionSize?: number
  closedSize?: number
  pnlUsd?: number
  status?: string
}

export function formatPriceWithComma(price: number | undefined): string {
  if (price === undefined || price === 0) return NULL_DISPLAY
  return price.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: price >= 1 ? 2 : 4,
  })
}

export function formatSizeWithUnit(size: number | undefined, unit: string): string {
  if (size === undefined || size === 0) return NULL_DISPLAY
  return `${size.toFixed(3)} ${unit}`
}

export function formatPrice(price: number | undefined): string {
  if (price === undefined || price === 0) return NULL_DISPLAY
  return price >= 1 ? price.toFixed(2) : price.toFixed(4)
}

export function formatDateTime(timeStr: string, language?: string): string {
  if (!timeStr) return NULL_DISPLAY
  const date = new Date(timeStr)
  const localeMap: Record<string, string> = { zh: 'zh-CN', ja: 'ja-JP', ko: 'ko-KR' }
  const locale = language ? (localeMap[language] || 'en-US') : 'en-US'
  return date.toLocaleString(locale, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export const thStyle = {
  padding: tokens.spacing[4],
  fontSize: tokens.typography.fontSize.xs,
  color: tokens.colors.text.tertiary,
  fontWeight: tokens.typography.fontWeight.bold,
  borderBottom: `1px solid ${tokens.colors.border.primary}40`,
}
