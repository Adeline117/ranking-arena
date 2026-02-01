/**
 * Web3 contract addresses, constants, and shared RPC client.
 *
 * Server-safe — no client-only dependencies (wagmi, RainbowKit).
 * Import this file in API routes instead of ./config to avoid
 * pulling in client-only modules.
 */

import { createPublicClient, http } from 'viem'
import { base, baseSepolia } from 'viem/chains'

const isProduction = process.env.NODE_ENV === 'production'

/** Target chain: Base mainnet in production, Base Sepolia in development */
export const baseChain = isProduction ? base : baseSepolia

/** Base RPC URL from environment or public default */
export const baseRpcUrl = isProduction
  ? (process.env.BASE_RPC_URL || process.env.NEXT_PUBLIC_BASE_RPC_URL || 'https://mainnet.base.org')
  : (process.env.BASE_SEPOLIA_RPC_URL || process.env.NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org')

/**
 * Shared public client for on-chain reads on Base.
 * Used by eas.ts, nft.ts, and API routes.
 */
export const basePublicClient = createPublicClient({
  chain: baseChain,
  transport: http(baseRpcUrl),
})

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
