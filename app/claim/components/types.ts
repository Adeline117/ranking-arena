export interface SearchResult {
  handle: string
  source: string
  source_trader_id: string
  avatar_url?: string
  roi?: number
  arena_score?: number
}

export interface LinkedTrader {
  id: string
  trader_id: string
  source: string
  label: string | null
  is_primary: boolean
  display_order: number
  verified_at: string
  verification_method: string
  stats?: {
    arena_score?: number
    roi?: number
    pnl?: number
    rank?: number
    handle?: string
    avatar_url?: string
  } | null
}

export const CEX_PLATFORMS = [
  { value: 'binance_futures', label: 'Binance Futures', requiresPassphrase: false },
  { value: 'binance', label: 'Binance', requiresPassphrase: false },
  { value: 'bybit', label: 'Bybit', requiresPassphrase: false },
  { value: 'okx', label: 'OKX', requiresPassphrase: true },
  { value: 'bitget', label: 'Bitget', requiresPassphrase: true },
  { value: 'gateio', label: 'Gate.io', requiresPassphrase: false },
  { value: 'htx', label: 'HTX (Huobi)', requiresPassphrase: false },
]

export const DEX_PLATFORMS = [
  'hyperliquid', 'gmx', 'gains', 'aevo', 'kwenta', 'vertex', 'dydx',
  'jupiter_perps', 'drift',
]

export const SOLANA_PLATFORMS = ['jupiter_perps', 'drift']

export function isDex(source: string): boolean {
  return DEX_PLATFORMS.some(p => source.toLowerCase() === p)
}

export function isSolanaDex(source: string): boolean {
  return SOLANA_PLATFORMS.some(p => source.toLowerCase() === p)
}
