/**
 * Multi-Chain Configuration
 *
 * Supports multiple EVM chains for Web3 features:
 * - Base (primary)
 * - Arbitrum
 * - Optimism
 * - Polygon
 *
 * Each chain may have different contract deployments.
 */

import { createPublicClient, http, type Chain, type PublicClient } from 'viem'
import { base, baseSepolia, arbitrum, optimism, polygon } from 'viem/chains'

// ── Chain IDs ──

export const CHAIN_IDS = {
  BASE: 8453,
  BASE_SEPOLIA: 84532,
  ARBITRUM: 42161,
  OPTIMISM: 10,
  POLYGON: 137,
} as const

export type SupportedChainId = typeof CHAIN_IDS[keyof typeof CHAIN_IDS]

// ── Chain Configurations ──

export interface ChainConfig {
  id: SupportedChainId
  name: string
  shortName: string
  chain: Chain
  rpcUrl: string
  explorerUrl: string
  nativeCurrency: { name: string; symbol: string; decimals: number }
  isTestnet: boolean
  isSupported: boolean // Whether Arena features are deployed
  contracts: {
    membershipNFT?: `0x${string}`
    copyTrading?: `0x${string}`
  }
}

const isProduction = process.env.NODE_ENV === 'production'

export const CHAIN_CONFIGS: Record<SupportedChainId, ChainConfig> = {
  [CHAIN_IDS.BASE]: {
    id: CHAIN_IDS.BASE,
    name: 'Base',
    shortName: 'base',
    chain: base,
    rpcUrl: process.env.BASE_RPC_URL || 'https://mainnet.base.org',
    explorerUrl: 'https://basescan.org',
    nativeCurrency: { name: 'Ethereum', symbol: 'ETH', decimals: 18 },
    isTestnet: false,
    isSupported: true,
    contracts: {
      membershipNFT: process.env.NEXT_PUBLIC_MEMBERSHIP_NFT_ADDRESS as `0x${string}` | undefined,
      copyTrading: process.env.NEXT_PUBLIC_COPY_TRADING_BASE as `0x${string}` | undefined,
    },
  },
  [CHAIN_IDS.BASE_SEPOLIA]: {
    id: CHAIN_IDS.BASE_SEPOLIA,
    name: 'Base Sepolia',
    shortName: 'base-sepolia',
    chain: baseSepolia,
    rpcUrl: process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org',
    explorerUrl: 'https://sepolia.basescan.org',
    nativeCurrency: { name: 'Ethereum', symbol: 'ETH', decimals: 18 },
    isTestnet: true,
    isSupported: !isProduction,
    contracts: {
      membershipNFT: process.env.NEXT_PUBLIC_MEMBERSHIP_NFT_ADDRESS as `0x${string}` | undefined,
      copyTrading: process.env.NEXT_PUBLIC_COPY_TRADING_BASE_SEPOLIA as `0x${string}` | undefined,
    },
  },
  [CHAIN_IDS.ARBITRUM]: {
    id: CHAIN_IDS.ARBITRUM,
    name: 'Arbitrum One',
    shortName: 'arb',
    chain: arbitrum,
    rpcUrl: process.env.ARBITRUM_RPC_URL || 'https://arb1.arbitrum.io/rpc',
    explorerUrl: 'https://arbiscan.io',
    nativeCurrency: { name: 'Ethereum', symbol: 'ETH', decimals: 18 },
    isTestnet: false,
    isSupported: false, // Not deployed yet
    contracts: {
      copyTrading: process.env.NEXT_PUBLIC_COPY_TRADING_ARBITRUM as `0x${string}` | undefined,
    },
  },
  [CHAIN_IDS.OPTIMISM]: {
    id: CHAIN_IDS.OPTIMISM,
    name: 'Optimism',
    shortName: 'op',
    chain: optimism,
    rpcUrl: process.env.OPTIMISM_RPC_URL || 'https://mainnet.optimism.io',
    explorerUrl: 'https://optimistic.etherscan.io',
    nativeCurrency: { name: 'Ethereum', symbol: 'ETH', decimals: 18 },
    isTestnet: false,
    isSupported: false, // Not deployed yet
    contracts: {
      copyTrading: process.env.NEXT_PUBLIC_COPY_TRADING_OPTIMISM as `0x${string}` | undefined,
    },
  },
  [CHAIN_IDS.POLYGON]: {
    id: CHAIN_IDS.POLYGON,
    name: 'Polygon',
    shortName: 'matic',
    chain: polygon,
    rpcUrl: process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com',
    explorerUrl: 'https://polygonscan.com',
    nativeCurrency: { name: 'MATIC', symbol: 'MATIC', decimals: 18 },
    isTestnet: false,
    isSupported: false, // Not deployed yet
    contracts: {},
  },
}

// ── Client Management ──

const clients = new Map<SupportedChainId, PublicClient>()

/**
 * Get a public client for a specific chain.
 */
export function getPublicClient(chainId: SupportedChainId): PublicClient {
  const cached = clients.get(chainId)
  if (cached) return cached

  const config = CHAIN_CONFIGS[chainId]
  if (!config) {
    throw new Error(`Unsupported chain ID: ${chainId}`)
  }

  const client = createPublicClient({
    chain: config.chain,
    transport: http(config.rpcUrl),
  })

  clients.set(chainId, client)
  return client
}

/**
 * Get the default chain for Arena features.
 */
export function getDefaultChain(): ChainConfig {
  return isProduction ? CHAIN_CONFIGS[CHAIN_IDS.BASE] : CHAIN_CONFIGS[CHAIN_IDS.BASE_SEPOLIA]
}

/**
 * Get all supported chains.
 */
export function getSupportedChains(): ChainConfig[] {
  return Object.values(CHAIN_CONFIGS).filter((c) => c.isSupported)
}

/**
 * Get all production chains.
 */
export function getProductionChains(): ChainConfig[] {
  return Object.values(CHAIN_CONFIGS).filter((c) => !c.isTestnet && c.isSupported)
}

/**
 * Check if a chain is supported.
 */
export function isChainSupported(chainId: number): chainId is SupportedChainId {
  const config = CHAIN_CONFIGS[chainId as SupportedChainId]
  return config?.isSupported ?? false
}

/**
 * Get chain config by ID.
 */
export function getChainConfig(chainId: SupportedChainId): ChainConfig | null {
  return CHAIN_CONFIGS[chainId] ?? null
}

/**
 * Get explorer URL for a transaction.
 */
export function getTxExplorerUrl(chainId: SupportedChainId, txHash: string): string {
  const config = CHAIN_CONFIGS[chainId]
  return `${config?.explorerUrl || 'https://basescan.org'}/tx/${txHash}`
}

/**
 * Get explorer URL for an address.
 */
export function getAddressExplorerUrl(chainId: SupportedChainId, address: string): string {
  const config = CHAIN_CONFIGS[chainId]
  return `${config?.explorerUrl || 'https://basescan.org'}/address/${address}`
}

/**
 * Format chain name for display.
 */
export function formatChainName(chainId: SupportedChainId): string {
  const config = CHAIN_CONFIGS[chainId]
  return config?.name || `Chain ${chainId}`
}
