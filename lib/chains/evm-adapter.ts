/**
 * EVM Adapter
 *
 * Unified interface for reading on-chain data across all supported EVM chains.
 * Uses viem public clients with cached instances per chain.
 */

import {
  createPublicClient,
  http,
  formatUnits,
  type PublicClient,
  type Address,
  parseAbi,
} from 'viem'
import { EVM_CHAINS, SUPPORTED_CHAIN_IDS, type EVMChainConfig } from './config'

// ── Types ──

export interface NativeBalance {
  chainId: number
  chainName: string
  symbol: string
  balance: string
  decimals: number
}

export interface TokenBalance {
  chainId: number
  chainName: string
  contractAddress: string
  symbol: string
  name: string
  balance: string
  decimals: number
}

export interface Transaction {
  hash: string
  chainId: number
  chainName: string
  from: string
  to: string
  value: string
  blockNumber: number
  timestamp: number
}

export interface ChainPortfolio {
  chainId: number
  chainName: string
  nativeBalance: NativeBalance
  tokens: TokenBalance[]
  error?: string
}

export interface Portfolio {
  address: string
  chains: ChainPortfolio[]
  totalChains: number
  chainsWithBalance: number
  queriedAt: number
}

// ── ERC20 ABI fragments ──

const ERC20_ABI = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
])

// ── Client cache ──

const clientCache = new Map<number, PublicClient>()

function getClient(chainId: number): PublicClient {
  const existing = clientCache.get(chainId)
  if (existing) return existing

  const config = EVM_CHAINS[chainId]
  if (!config) {
    throw new Error(`Unsupported chain: ${chainId}`)
  }

  const client = createPublicClient({
    chain: config.chain,
    transport: http(config.rpcUrl),
    batch: { multicall: true },
  })

  clientCache.set(chainId, client)
  return client
}

// ── Public API ──

/**
 * Get native token balance for an address on a specific chain.
 */
export async function getBalance(
  address: string,
  chainId: number
): Promise<NativeBalance> {
  const config = EVM_CHAINS[chainId]
  if (!config) throw new Error(`Unsupported chain: ${chainId}`)

  const client = getClient(chainId)
  const raw = await client.getBalance({ address: address as Address })

  return {
    chainId,
    chainName: config.name,
    symbol: config.nativeCurrency.symbol,
    balance: formatUnits(raw, config.nativeCurrency.decimals),
    decimals: config.nativeCurrency.decimals,
  }
}

/**
 * Get ERC20 token balance for an address on a specific chain.
 */
export async function getTokenBalance(
  address: string,
  tokenAddress: string,
  chainId: number
): Promise<TokenBalance> {
  const config = EVM_CHAINS[chainId]
  if (!config) throw new Error(`Unsupported chain: ${chainId}`)

  const client = getClient(chainId)
  const token = tokenAddress as Address
  const owner = address as Address

  const [rawBalance, decimals, symbol, name] = await Promise.all([
    client.readContract({ address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [owner] }),
    client.readContract({ address: token, abi: ERC20_ABI, functionName: 'decimals' }),
    client.readContract({ address: token, abi: ERC20_ABI, functionName: 'symbol' }),
    client.readContract({ address: token, abi: ERC20_ABI, functionName: 'name' }),
  ])

  return {
    chainId,
    chainName: config.name,
    contractAddress: tokenAddress,
    symbol: symbol as string,
    name: name as string,
    balance: formatUnits(rawBalance as bigint, decimals as number),
    decimals: decimals as number,
  }
}

/**
 * Get recent transactions for an address via block explorer API.
 * Requires an explorer API key env var (e.g. ETHERSCAN_API_KEY).
 */
export async function getTransactions(
  address: string,
  chainId: number,
  limit: number = 10
): Promise<Transaction[]> {
  const config = EVM_CHAINS[chainId]
  if (!config) throw new Error(`Unsupported chain: ${chainId}`)

  const apiKey = getExplorerApiKey(config)
  const params = new URLSearchParams({
    module: 'account',
    action: 'txlist',
    address,
    startblock: '0',
    endblock: '99999999',
    page: '1',
    offset: String(limit),
    sort: 'desc',
  })
  if (apiKey) params.set('apikey', apiKey)

  const url = `${config.explorerApiUrl}?${params.toString()}`

  try {
    const res = await fetch(url, { next: { revalidate: 30 } })
    const data = await res.json() as {
      status: string
      result: Array<{
        hash: string
        from: string
        to: string
        value: string
        blockNumber: string
        timeStamp: string
      }>
    }

    if (data.status !== '1' || !Array.isArray(data.result)) {
      return []
    }

    return data.result.map((tx) => ({
      hash: tx.hash,
      chainId,
      chainName: config.name,
      from: tx.from,
      to: tx.to,
      value: formatUnits(BigInt(tx.value), config.nativeCurrency.decimals),
      blockNumber: Number(tx.blockNumber),
      timestamp: Number(tx.timeStamp),
    }))
  } catch (_err) {
    /* non-critical: explorer API unavailable */
    return []
  }
}

/**
 * Get cross-chain portfolio for an address.
 * Queries all supported EVM chains in parallel.
 */
export async function getPortfolio(address: string): Promise<Portfolio> {
  const chainResults = await Promise.allSettled(
    SUPPORTED_CHAIN_IDS.map(async (chainId): Promise<ChainPortfolio> => {
      const config = EVM_CHAINS[chainId]
      try {
        const nativeBalance = await getBalance(address, chainId)
        return {
          chainId,
          chainName: config.name,
          nativeBalance,
          tokens: [],
        }
      } catch (err) {
        return {
          chainId,
          chainName: config.name,
          nativeBalance: {
            chainId,
            chainName: config.name,
            symbol: config.nativeCurrency.symbol,
            balance: '0',
            decimals: config.nativeCurrency.decimals,
          },
          tokens: [],
          error: err instanceof Error ? err.message : 'Unknown error',
        }
      }
    })
  )

  const chains = chainResults.map((r) => {
    if (r.status === 'fulfilled') return r.value
    return {
      chainId: 0,
      chainName: 'Unknown',
      nativeBalance: { chainId: 0, chainName: 'Unknown', symbol: '?', balance: '0', decimals: 18 },
      tokens: [],
      error: r.reason instanceof Error ? r.reason.message : 'Promise rejected',
    }
  })

  const chainsWithBalance = chains.filter(
    (c) => !c.error && (parseFloat(c.nativeBalance.balance) > 0 || c.tokens.length > 0)
  ).length

  return {
    address,
    chains,
    totalChains: chains.length,
    chainsWithBalance,
    queriedAt: Date.now(),
  }
}

// ── Internal helpers ──

function getExplorerApiKey(config: EVMChainConfig): string | undefined {
  const keyMap: Record<number, string | undefined> = {
    1: process.env.ETHERSCAN_API_KEY,
    42161: process.env.ARBISCAN_API_KEY,
    137: process.env.POLYGONSCAN_API_KEY,
    56: process.env.BSCSCAN_API_KEY,
    10: process.env.OPTIMISTIC_ETHERSCAN_API_KEY,
    8453: process.env.BASESCAN_API_KEY,
    43114: process.env.SNOWTRACE_API_KEY,
  }
  return keyMap[config.chainId]
}
