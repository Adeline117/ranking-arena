/**
 * Web3 Configuration (client-only)
 *
 * Wagmi + RainbowKit config for multi-chain support.
 * Primary chain is Base L2, with Arbitrum, Optimism, and Polygon ready for future use.
 *
 * WARNING: Do NOT import this file in server routes — it calls
 * RainbowKit's getDefaultConfig() which is client-only.
 * Use @/lib/web3/contracts for server-safe constants.
 */

import { http } from 'wagmi'
import { base, baseSepolia, arbitrum, optimism, polygon } from 'wagmi/chains'
import { getDefaultConfig } from '@rainbow-me/rainbowkit'
import { baseChain } from './contracts'

const isProduction = process.env.NODE_ENV === 'production'

/** Re-export for convenience; canonical source is contracts.ts */
export const targetChain = baseChain

/**
 * All supported chains for the application.
 * Base is primary; others are included for future multi-chain support.
 */
export const supportedChains = isProduction
  ? [base, arbitrum, optimism, polygon] as const
  : [baseSepolia, base] as const

/**
 * Wagmi + RainbowKit unified config.
 *
 * Uses a placeholder projectId when NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID
 * is not set (e.g. during static page generation). WalletConnect won't
 * work without a real ID, but injected wallets (MetaMask etc.) are fine.
 */
export const wagmiConfig = getDefaultConfig({
  appName: 'Arena',
  projectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || 'placeholder',
  chains: supportedChains,
  transports: {
    [base.id]: http(
      process.env.NEXT_PUBLIC_BASE_RPC_URL || 'https://mainnet.base.org'
    ),
    [baseSepolia.id]: http(
      process.env.NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org'
    ),
    [arbitrum.id]: http(
      process.env.ARBITRUM_RPC_URL || 'https://arb1.arbitrum.io/rpc'
    ),
    [optimism.id]: http(
      process.env.OPTIMISM_RPC_URL || 'https://mainnet.optimism.io'
    ),
    [polygon.id]: http(
      process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com'
    ),
  },
  ssr: true,
})
