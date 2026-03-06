import { tokens } from '@/lib/design-tokens'

export const SOURCE_CONFIG: Record<string, string> = {
  binance_futures: 'categoryFutures',
  binance_spot: 'categorySpot',
  binance_web3: 'categoryWeb3',
  bybit: 'categoryFutures',
  bitget_futures: 'categoryFutures',
  bitget_spot: 'categorySpot',
  mexc: 'categoryFutures',
  coinex: 'categoryFutures',
  okx_web3: 'categoryWeb3',
  kucoin: 'categoryFutures',
  gmx: 'categoryWeb3',
}

export function getSourceCategory(source?: string): 'web3' | 'spot' | 'futures' | null {
  if (!source) return null
  if (source.includes('web3') || source === 'gmx') return 'web3'
  if (source.includes('spot')) return 'spot'
  if (source.includes('futures') || source === 'bybit' || source === 'okx') return 'futures'
  return null
}

const CATEGORY_COLORS: Record<string, string> = {
  web3: tokens.colors.verified.web3,
  spot: tokens.colors.accent.translated,
  futures: tokens.colors.accent.warning,
}

const CATEGORY_I18N_KEYS: Record<string, string> = {
  web3: 'categoryWeb3',
  spot: 'categorySpot',
  futures: 'categoryFutures',
}

export function getTradingStyleTags(
  t: (key: string) => string,
  source?: string,
  roi90d?: number,
  maxDrawdown?: number,
  winRate?: number
): Array<{ label: string; color: string }> {
  const tags: Array<{ label: string; color: string }> = []

  const category = getSourceCategory(source)
  if (category) {
    tags.push({ label: t(CATEGORY_I18N_KEYS[category]), color: CATEGORY_COLORS[category] })
  }

  if (maxDrawdown !== undefined && Math.abs(maxDrawdown) < 10) {
    tags.push({ label: t('tagLowDrawdown'), color: tokens.colors.accent.success })
  }
  if (winRate !== undefined && winRate > 70) {
    tags.push({ label: t('tagHighWinRate'), color: tokens.colors.accent.success })
  }
  if (roi90d !== undefined && roi90d > 100) {
    tags.push({ label: t('tagHighReturns'), color: tokens.colors.accent.error })
  }

  return tags.slice(0, 3)
}

export function formatAum(aum: number): string {
  if (aum >= 1_000_000) return `$${(aum / 1_000_000).toFixed(1)}M`
  if (aum >= 1_000) return `$${(aum / 1_000).toFixed(0)}K`
  return `$${aum.toFixed(0)}`
}

export function getActiveDays(activeSince?: string): number | null {
  if (!activeSince) return null
  const start = new Date(activeSince)
  if (isNaN(start.getTime())) return null
  const now = new Date()
  return Math.floor((now.getTime() - start.getTime()) / (1000 * 60 * 60 * 24))
}

export function formatActiveDays(days: number, t: (key: string) => string): string {
  return days > 365 ? `${Math.floor(days / 365)}${t('activeYears')}` : `${days}${t('activeDaysUnit')}`
}
