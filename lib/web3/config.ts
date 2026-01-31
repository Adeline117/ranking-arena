/**
 * Web3 Configuration
 *
 * Wagmi + RainbowKit config for Base L2 chain.
 * Used by Web3Provider to enable wallet connections.
 */

import { http, createConfig } from 'wagmi'
import { base, baseSepolia } from 'wagmi/chains'
import { getDefaultConfig } from '@rainbow-me/rainbowkit'

const isProduction = process.env.NODE_ENV === 'production'

/**
 * Target chain based on environment.
 * Production uses Base mainnet, development uses Base Sepolia testnet.
 */
export const targetChain = isProduction ? base : baseSepolia

/**
 * Wagmi + RainbowKit unified config.
 * RainbowKit's getDefaultConfig sets up wagmi with wallet connectors.
 */
export const wagmiConfig = getDefaultConfig({
  appName: 'Arena',
  projectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || 'ranking-arena-dev',
  chains: [targetChain],
  transports: {
    [base.id]: http(
      process.env.NEXT_PUBLIC_BASE_RPC_URL || 'https://mainnet.base.org'
    ),
    [baseSepolia.id]: http(
      process.env.NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org'
    ),
  },
  ssr: true,
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
