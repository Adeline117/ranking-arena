import { isDexWalletPlatform, isSolanaPlatform } from '@/lib/constants/wallet-platforms'

/**
 * Canonical identity rules for wallet-owned trader profiles.
 *
 * EVM addresses are case-insensitive once checksum validation has happened, so
 * every database key must use lowercase. Solana public keys are Base58 and
 * case-sensitive: changing even one letter identifies a different account.
 */
export function canonicalizeWalletIdentity(identity: string, platform: string): string {
  if (typeof identity !== 'string' || identity.trim() === '') {
    throw new Error('Wallet identity must be a non-empty string')
  }

  if (!isDexWalletPlatform(platform)) {
    throw new Error(`Platform ${platform} does not use wallet identities`)
  }

  const value = identity.trim()
  return isSolanaPlatform(platform) ? value : value.toLowerCase()
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
