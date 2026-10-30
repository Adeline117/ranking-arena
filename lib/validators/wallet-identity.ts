import { isDexWalletPlatform } from '@/lib/constants/wallet-platforms'

/**
 * Canonical identity rules for wallet-owned trader profiles.
 *
 * V1 supports only EVM leaderboard identities. They are case-insensitive once
 * shape validation has happened, so every database key uses lowercase.
 */
export function canonicalizeWalletIdentity(identity: string, platform: string): string {
  if (typeof identity !== 'string' || identity.trim() === '') {
    throw new Error('Wallet identity must be a non-empty string')
  }

  if (!isDexWalletPlatform(platform)) {
    throw new Error(`Platform ${platform} does not use wallet identities`)
  }

  const value = identity.trim()
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error('EVM wallet identity must be a 20-byte hexadecimal address')
  }
  return value.toLowerCase()
}

export function walletIdentitiesMatch(left: string, right: string, platform: string): boolean {
  try {
    return (
      canonicalizeWalletIdentity(left, platform) === canonicalizeWalletIdentity(right, platform)
    )
  } catch {
    return false
  }
}
