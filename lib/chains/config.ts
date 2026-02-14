/**
 * Multi-Chain Configuration
 *
 * Defines all supported EVM chains with their metadata.
 * This is the canonical source for chain definitions used by
 * the EVM adapter and portfolio APIs.
 */

import type { Chain } from 'viem'
import {
  mainnet,
  arbitrum,
  polygon,
  bsc,
  optimism,
  base,
  avalanche,
} from 'viem/chains'

// ── Types ──

export interface NativeCurrency {
  name: string
  symbol: string
  decimals: number
}

export interface EVMChainConfig {
  chainId: number
  name: string
  shortName: string
  chain: Chain
  rpcUrl: string
  explorerUrl: string
  explorerApiUrl: string
  nativeCurrency: NativeCurrency
  icon: string
  isTestnet: boolean
}

// ── Chain Definitions ──

export const EVM_CHAINS: Record<number, EVMChainConfig> = {
  1: {
    chainId: 1,
    name: 'Ethereum',
    shortName: 'eth',
    chain: mainnet,
    rpcUrl: process.env.ETHEREUM_RPC_URL || 'https://eth.llamarpc.com',
    explorerUrl: 'https://etherscan.io',
    explorerApiUrl: 'https://api.etherscan.io/api',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    icon: '/chains/ethereum.svg',
    isTestnet: false,
  },
  42161: {
    chainId: 42161,
    name: 'Arbitrum One',
    shortName: 'arb',
    chain: arbitrum,
    rpcUrl: process.env.ARBITRUM_RPC_URL || 'https://arb1.arbitrum.io/rpc',
    explorerUrl: 'https://arbiscan.io',
    explorerApiUrl: 'https://api.arbiscan.io/api',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    icon: '/chains/arbitrum.svg',
    isTestnet: false,
  },
  137: {
    chainId: 137,
    name: 'Polygon',
    shortName: 'matic',
    chain: polygon,
    rpcUrl: process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com',
    explorerUrl: 'https://polygonscan.com',
    explorerApiUrl: 'https://api.polygonscan.com/api',
    nativeCurrency: { name: 'MATIC', symbol: 'MATIC', decimals: 18 },
    icon: '/chains/polygon.svg',
    isTestnet: false,
  },
  56: {
    chainId: 56,
    name: 'BNB Smart Chain',
    shortName: 'bsc',
    chain: bsc,
    rpcUrl: process.env.BSC_RPC_URL || 'https://bsc-dataseed.binance.org',
    explorerUrl: 'https://bscscan.com',
    explorerApiUrl: 'https://api.bscscan.com/api',
    nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
    icon: '/chains/bsc.svg',
    isTestnet: false,
  },
  10: {
    chainId: 10,
    name: 'Optimism',
    shortName: 'op',
    chain: optimism,
    rpcUrl: process.env.OPTIMISM_RPC_URL || 'https://mainnet.optimism.io',
    explorerUrl: 'https://optimistic.etherscan.io',
    explorerApiUrl: 'https://api-optimistic.etherscan.io/api',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    icon: '/chains/optimism.svg',
    isTestnet: false,
  },
  8453: {
    chainId: 8453,
    name: 'Base',
    shortName: 'base',
    chain: base,
    rpcUrl: process.env.BASE_RPC_URL || 'https://mainnet.base.org',
    explorerUrl: 'https://basescan.org',
    explorerApiUrl: 'https://api.basescan.org/api',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    icon: '/chains/base.svg',
    isTestnet: false,
  },
  43114: {
    chainId: 43114,
    name: 'Avalanche C-Chain',
    shortName: 'avax',
    chain: avalanche,
    rpcUrl: process.env.AVALANCHE_RPC_URL || 'https://api.avax.network/ext/bc/C/rpc',
    explorerUrl: 'https://snowtrace.io',
    explorerApiUrl: 'https://api.snowtrace.io/api',
    nativeCurrency: { name: 'Avalanche', symbol: 'AVAX', decimals: 18 },
    icon: '/chains/avalanche.svg',
    isTestnet: false,
  },
}

// ── Helpers ──

export const SUPPORTED_CHAIN_IDS = Object.keys(EVM_CHAINS).map(Number)

export function getChainConfig(chainId: number): EVMChainConfig | undefined {
  return EVM_CHAINS[chainId]
}

export function getChainByShortName(shortName: string): EVMChainConfig | undefined {
  return Object.values(EVM_CHAINS).find((c) => c.shortName === shortName)
}

export function isSupported(chainId: number): boolean {
  return chainId in EVM_CHAINS
}

/**
 * Returns a serializable summary of all supported chains (no viem Chain objects).
 */
export function getChainsPublicInfo() {
  return Object.values(EVM_CHAINS).map((c) => ({
    chainId: c.chainId,
    name: c.name,
    shortName: c.shortName,
    explorerUrl: c.explorerUrl,
    nativeCurrency: c.nativeCurrency,
    icon: c.icon,
    isTestnet: c.isTestnet,
  }))
}
