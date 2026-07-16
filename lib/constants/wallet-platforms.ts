/** Client-safe platform contract for wallet-owned trader claims. */
export const EVM_WALLET_PLATFORMS = ['hyperliquid', 'gmx', 'gains', 'aevo', 'dydx'] as const

export const SOLANA_WALLET_PLATFORMS = ['jupiter_perps', 'drift'] as const

export const WALLET_CLAIM_PLATFORMS = [...EVM_WALLET_PLATFORMS, ...SOLANA_WALLET_PLATFORMS] as const

export function isDexWalletPlatform(platform: string): boolean {
  const normalized = platform.toLowerCase()
  return WALLET_CLAIM_PLATFORMS.some((candidate) => candidate === normalized)
}

export function isSolanaPlatform(platform: string): boolean {
  const normalized = platform.toLowerCase()
  return SOLANA_WALLET_PLATFORMS.some((candidate) => candidate === normalized)
}
