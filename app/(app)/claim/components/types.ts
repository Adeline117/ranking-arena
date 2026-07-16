import { EXCHANGE_CONFIG } from '@/lib/constants/exchanges'
import { SOLANA_WALLET_PLATFORMS } from '@/lib/constants/wallet-platforms'
import { walletIdentitiesMatch } from '@/lib/validators/wallet-identity'

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

// Derive CEX platforms from EXCHANGE_CONFIG so adding a new exchange with
// requiresPassphrase: true automatically shows the passphrase field in the claim form.
export const CEX_PLATFORMS = (
  Object.entries(EXCHANGE_CONFIG) as [
    string,
    (typeof EXCHANGE_CONFIG)[keyof typeof EXCHANGE_CONFIG],
  ][]
)
  .filter(([, config]) => config.sourceType === 'futures' || config.sourceType === 'spot')
  .map(([value, config]) => ({
    value,
    label: config.name,
    requiresPassphrase: config.requiresPassphrase ?? false,
  }))

export const DEX_PLATFORMS = [
  'hyperliquid',
  'gmx',
  'gains',
  'aevo',
  'kwenta',
  'vertex',
  'dydx',
  'jupiter_perps',
  'drift',
]

export const SOLANA_PLATFORMS = [...SOLANA_WALLET_PLATFORMS]

export function isDex(source: string): boolean {
  return DEX_PLATFORMS.some((p) => source.toLowerCase() === p)
}

export function isSolanaDex(source: string): boolean {
  return SOLANA_PLATFORMS.some((p) => source.toLowerCase() === p)
}

export function walletMatchesTrader(
  walletAddress: string,
  traderId: string,
  source: string
): boolean {
  return walletIdentitiesMatch(walletAddress, traderId, source)
}
