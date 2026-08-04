/** Client-safe platform contract for wallet-owned trader claims. */
export const EVM_WALLET_PLATFORMS = ['hyperliquid', 'gmx'] as const

export const WALLET_CLAIM_PLATFORMS = [...EVM_WALLET_PLATFORMS] as const

export function isDexWalletPlatform(platform: string): boolean {
  const normalized = platform.toLowerCase()
  return WALLET_CLAIM_PLATFORMS.some((candidate) => candidate === normalized)
}
