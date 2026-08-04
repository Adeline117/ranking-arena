import { WALLET_CLAIM_PLATFORMS } from '@/lib/constants/wallet-platforms'
import { claimMethodForSource } from '@/lib/constants/trader-claim-platforms'
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

export const DEX_PLATFORMS = [...WALLET_CLAIM_PLATFORMS]

export function isDex(source: string): boolean {
  return claimMethodForSource(source) === 'signature'
}

export function walletMatchesTrader(
  walletAddress: string,
  traderId: string,
  source: string
): boolean {
  return walletIdentitiesMatch(walletAddress, traderId, source)
}
