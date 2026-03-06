// 平台配置
export const sourceConfig: Record<string, { label: string; labelEn: string; color: string }> = {
  binance_futures: { label: 'Binance 合约', labelEn: 'Binance Futures', color: 'var(--color-chart-amber)' },
  binance_spot: { label: 'Binance 现货', labelEn: 'Binance Spot', color: 'var(--color-chart-amber)' },
  binance_web3: { label: 'Binance 链上', labelEn: 'Binance Web3', color: 'var(--color-chart-amber)' },
  bybit: { label: 'Bybit 合约', labelEn: 'Bybit Futures', color: 'var(--color-chart-orange)' },
  bitget_futures: { label: 'Bitget 合约', labelEn: 'Bitget Futures', color: 'var(--color-accent-success)' },
  bitget_spot: { label: 'Bitget 现货', labelEn: 'Bitget Spot', color: 'var(--color-accent-success)' },
  okx_web3: { label: 'OKX 链上', labelEn: 'OKX Web3', color: 'var(--color-text-primary)' },
  kucoin: { label: 'KuCoin 合约', labelEn: 'KuCoin Futures', color: 'var(--color-chart-teal)' },
  mexc: { label: 'MEXC 合约', labelEn: 'MEXC Futures', color: 'var(--color-chart-indigo)' },
  coinex: { label: 'CoinEx 合约', labelEn: 'CoinEx Futures', color: 'var(--color-chart-blue)' },
  gmx: { label: 'GMX 链上', labelEn: 'GMX DeFi', color: 'var(--color-chart-blue)' },
}

export const getSourceDisplayName = (source: string, lang: string) =>
  lang === 'en'
    ? sourceConfig[source]?.labelEn || source
    : sourceConfig[source]?.label || source

export const getSourceColor = (source: string) => sourceConfig[source]?.color || 'var(--color-text-secondary)'

// 统一的关注项类型
export type FollowItem = {
  id: string
  handle: string
  type: 'trader' | 'user'
  avatar_url?: string
  bio?: string
  roi?: number
  roi_7d?: number
  roi_30d?: number
  pnl?: number
  win_rate?: number
  followers?: number
  source?: string
  arena_score?: number
  followed_at?: string
}

export type SortMode = 'recent' | 'roi' | 'score'
