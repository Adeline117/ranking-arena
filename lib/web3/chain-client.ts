/**
 * EVM Chain Public Clients via viem
 * Provides read-only access to multiple EVM chains using free RPC endpoints.
 */

import { createPublicClient, http, type PublicClient, type Chain } from 'viem'
import {
  mainnet,
  bsc,
  arbitrum,
  polygon,
  base,
  optimism,
} from 'viem/chains'

export interface SupportedChain {
  id: number
  name: string
  chain: Chain
  rpcUrl: string
  nativeSymbol: string
  nativeDecimals: number
  blockExplorer: string
}

export const SUPPORTED_CHAINS: Record<number, SupportedChain> = {
  1: {
    id: 1,
    name: 'Ethereum',
    chain: mainnet,
    rpcUrl: 'https://eth.llamarpc.com',
    nativeSymbol: 'ETH',
    nativeDecimals: 18,
    blockExplorer: 'https://etherscan.io',
  },
  56: {
    id: 56,
    name: 'BNB Smart Chain',
    chain: bsc,
    rpcUrl: 'https://bsc-dataseed.binance.org',
    nativeSymbol: 'BNB',
    nativeDecimals: 18,
    blockExplorer: 'https://bscscan.com',
  },
  42161: {
    id: 42161,
    name: 'Arbitrum One',
    chain: arbitrum,
    rpcUrl: 'https://arb1.arbitrum.io/rpc',
    nativeSymbol: 'ETH',
    nativeDecimals: 18,
    blockExplorer: 'https://arbiscan.io',
  },
  137: {
    id: 137,
    name: 'Polygon',
    chain: polygon,
    rpcUrl: 'https://polygon-rpc.com',
    nativeSymbol: 'MATIC',
    nativeDecimals: 18,
    blockExplorer: 'https://polygonscan.com',
  },
  8453: {
    id: 8453,
    name: 'Base',
    chain: base,
    rpcUrl: 'https://mainnet.base.org',
    nativeSymbol: 'ETH',
    nativeDecimals: 18,
    blockExplorer: 'https://basescan.org',
  },
  10: {
    id: 10,
    name: 'Optimism',
    chain: optimism,
    rpcUrl: 'https://mainnet.optimism.io',
    nativeSymbol: 'ETH',
    nativeDecimals: 18,
    blockExplorer: 'https://optimistic.etherscan.io',
  },
}

const clientCache = new Map<number, PublicClient>()

/**
 * Get or create a cached public client for the given chain ID.
 */
export function getChainClient(chainId: number): PublicClient {
  const existing = clientCache.get(chainId)
  if (existing) return existing

  const chainConfig = SUPPORTED_CHAINS[chainId]
  if (!chainConfig) {
    throw new Error(`Unsupported chain ID: ${chainId}. Supported: ${Object.keys(SUPPORTED_CHAINS).join(', ')}`)
  }

  const client = createPublicClient({
    chain: chainConfig.chain,
    transport: http(chainConfig.rpcUrl),
  })

  clientCache.set(chainId, client)
  return client
}
