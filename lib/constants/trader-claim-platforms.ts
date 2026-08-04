import { isDexWalletPlatform } from '@/lib/constants/wallet-platforms'

/** The only verification paths implemented by the trader-claim control plane. */
export type TraderClaimMethod = 'api_key' | 'signature' | 'unsupported'

/**
 * Exact CEX sources whose leaderboard identity can be resolved from an API key.
 *
 * V1 intentionally ships none. The implemented credential resolvers return an
 * exchange account UID, while current public boards use a different identity:
 * Binance leadPortfolioId, Bybit leaderMark, OKX uniqueCode, and Bitget's
 * public traderUid/traderId (plus portfolioId on UTA). Gate/HTX additionally
 * lack an implemented exchange-authoritative read-only permission proof.
 */
export const CEX_API_KEY_CLAIM_PLATFORMS = [] as const

/**
 * Account-connection keys remain useful for read-only first-party binding.
 * Membership here does not advertise or authorize trader-profile claims.
 */
const CEX_ACCOUNT_CONNECTION_PLATFORMS = [
  'binance',
  'binance_futures',
  'binance_spot',
  'bybit',
  'bybit_spot',
  'okx',
  'okx_futures',
  'okx_spot',
  'bitget',
  'bitget_futures',
  'bitget_spot',
] as const

const CEX_API_KEY_CLAIM_PLATFORM_SET = new Set<string>(CEX_API_KEY_CLAIM_PLATFORMS)
const CEX_ACCOUNT_CONNECTION_PLATFORM_SET = new Set<string>(CEX_ACCOUNT_CONNECTION_PLATFORMS)

/**
 * Resolve one source to the verification method Arena can actually execute.
 *
 * Matching is deliberately exact. A shared brand prefix is not proof that the
 * leaderboard identifier has account-UID semantics: web3, bots, CFD, and MT5
 * boards must remain unsupported until they get a purpose-built verifier.
 */
export function claimMethodForSource(source: string): TraderClaimMethod {
  const normalizedSource = source.trim().toLowerCase()
  if (!normalizedSource) return 'unsupported'

  if (isDexWalletPlatform(normalizedSource)) return 'signature'
  return CEX_API_KEY_CLAIM_PLATFORM_SET.has(normalizedSource) ? 'api_key' : 'unsupported'
}

export function isCexApiKeyClaimSource(source: string): boolean {
  return claimMethodForSource(source) === 'api_key'
}

/** Base exchange key used by a separate encrypted first-party connection. */
export function accountConnectionExchangeForSource(source: string): string | null {
  const normalizedSource = source.trim().toLowerCase()
  if (!CEX_ACCOUNT_CONNECTION_PLATFORM_SET.has(normalizedSource)) return null
  return normalizedSource.replace(/_(futures|spot)$/, '')
}
