/**
 * Web3 contract addresses and constants.
 *
 * Server-safe — no client-only dependencies (wagmi, RainbowKit).
 * Import this file in API routes instead of ./config to avoid
 * pulling in client-only modules.
 */

/**
 * Contract addresses deployed on Base.
 * These are set via environment variables after deployment.
 */
export const CONTRACT_ADDRESSES = {
  membershipNFT: process.env.NEXT_PUBLIC_MEMBERSHIP_NFT_ADDRESS as `0x${string}` | undefined,
  easSchemaRegistry: '0x4200000000000000000000000000000000000020' as const, // Base EAS
  eas: '0x4200000000000000000000000000000000000021' as const, // Base EAS
} as const

/** Arena Score EAS Schema UID — set after registering the schema on Base */
export const ARENA_SCORE_SCHEMA_UID = process.env.NEXT_PUBLIC_ARENA_SCORE_SCHEMA_UID as `0x${string}` | undefined
