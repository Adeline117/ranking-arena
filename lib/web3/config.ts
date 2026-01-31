/**
 * Web3 Configuration (client-only)
 *
 * Wagmi + RainbowKit config for Base L2 chain.
 * Used by Web3Provider to enable wallet connections.
 *
 * WARNING: Do NOT import this file in server routes — it calls
 * RainbowKit's getDefaultConfig() which is client-only.
 * Use @/lib/web3/contracts for server-safe constants.
 */

import { http } from 'wagmi'
import { base, baseSepolia } from 'wagmi/chains'
import { getDefaultConfig } from '@rainbow-me/rainbowkit'

// Re-export server-safe constants for backwards compatibility
export { CONTRACT_ADDRESSES, ARENA_SCORE_SCHEMA_UID } from './contracts'

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
