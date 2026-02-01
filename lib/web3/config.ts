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
import { baseChain } from './contracts'

/** Re-export for convenience; canonical source is contracts.ts */
export const targetChain = baseChain

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
