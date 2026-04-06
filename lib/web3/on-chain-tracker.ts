/**
 * On-Chain Tracker
 * Fetches wallet balances, token holdings, and recent transactions via viem.
 */

import { type Address, formatUnits, erc20Abi } from 'viem'
import { getChainClient, SUPPORTED_CHAINS } from './chain-client'

// --- Types ---

export interface WalletBalance {
  address: string
  chainId: number
  chainName: string
  nativeBalance: string
  nativeSymbol: string
  nativeBalanceRaw: bigint
}

export interface TokenHolding {
  address: string
  chainId: number
  contractAddress: string
  symbol: string
  name: string
  decimals: number
  balance: string
  balanceRaw: bigint
}

export interface Transaction {
  hash: string
  blockNumber: bigint
  from: string
  to: string | null
  value: string
  gasUsed: bigint | null
  timestamp: number | null
  status: 'success' | 'reverted' | 'unknown'
}

// Well-known ERC20 tokens per chain (top tokens for balance checks)
const TRACKED_TOKENS: Record<number, Array<{ address: Address; symbol: string; name: string; decimals: number }>> = {
  1: [
    { address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', symbol: 'USDT', name: 'Tether USD', decimals: 6 },
    { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', symbol: 'USDC', name: 'USD Coin', decimals: 6 },
    { address: '0x6B175474E89094C44Da98b954EedeAC495271d0F', symbol: 'DAI', name: 'Dai Stablecoin', decimals: 18 },
    { address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', symbol: 'WBTC', name: 'Wrapped BTC', decimals: 8 },
  ],
  56: [
    { address: '0x55d398326f99059fF775485246999027B3197955', symbol: 'USDT', name: 'Tether USD', decimals: 18 },
    { address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', symbol: 'USDC', name: 'USD Coin', decimals: 18 },
  ],
  42161: [
    { address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', symbol: 'USDT', name: 'Tether USD', decimals: 6 },
    { address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', symbol: 'USDC', name: 'USD Coin', decimals: 6 },
  ],
  137: [
    { address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', symbol: 'USDT', name: 'Tether USD', decimals: 6 },
    { address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', symbol: 'USDC', name: 'USD Coin', decimals: 6 },
  ],
  8453: [
    { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC', name: 'USD Coin', decimals: 6 },
  ],
  10: [
    { address: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', symbol: 'USDT', name: 'Tether USD', decimals: 6 },
    { address: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', symbol: 'USDC', name: 'USD Coin', decimals: 6 },
  ],
}

/**
 * Get native token balance for a wallet on a specific chain.
 */
export async function getWalletBalance(address: string, chainId: number = 1): Promise<WalletBalance> {
  const client = getChainClient(chainId)
  const chainConfig = SUPPORTED_CHAINS[chainId]

  const balance = await client.getBalance({ address: address as Address })

  return {
    address,
    chainId,
    chainName: chainConfig.name,
    nativeBalance: formatUnits(balance, chainConfig.nativeDecimals),
    nativeSymbol: chainConfig.nativeSymbol,
    nativeBalanceRaw: balance,
  }
}

/**
 * Get ERC20 token holdings for a wallet on a specific chain.
 */
export async function getTokenHoldings(address: string, chainId: number = 1): Promise<TokenHolding[]> {
  const client = getChainClient(chainId)
  const tokens = TRACKED_TOKENS[chainId] || []

  const results = await Promise.allSettled(
    tokens.map(async (token) => {
      const balance = await client.readContract({
        address: token.address,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [address as Address],
      })

      return {
        address,
        chainId,
        contractAddress: token.address,
        symbol: token.symbol,
        name: token.name,
        decimals: token.decimals,
        balance: formatUnits(balance, token.decimals),
        balanceRaw: balance,
      }
    })
  )

  const fulfilled: TokenHolding[] = []
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value.balanceRaw > 0n) {
      fulfilled.push(r.value)
    }
  }
  return fulfilled
}

/**
 * Get recent transactions for a wallet.
 * Uses getBlock to scan recent blocks. Limited by RPC capabilities.
 */
export async function getRecentTransactions(
  address: string,
  chainId: number = 1,
  limit: number = 10
): Promise<Transaction[]> {
  const client = getChainClient(chainId)
  const addr = address.toLowerCase()

  const currentBlock = await client.getBlockNumber()
  const transactions: Transaction[] = []

  // Scan last ~100 blocks (free RPCs don't support trace/filter well)
  const blocksToScan = 100
  const startBlock = currentBlock - BigInt(blocksToScan)

  for (let blockNum = currentBlock; blockNum > startBlock && transactions.length < limit; blockNum--) {
    try {
      const block = await client.getBlock({
        blockNumber: blockNum,
        includeTransactions: true,
      })

      for (const tx of block.transactions) {
        if (typeof tx === 'string') continue
        if (tx.from.toLowerCase() === addr || tx.to?.toLowerCase() === addr) {
          let receipt = null
          try {
            receipt = await client.getTransactionReceipt({ hash: tx.hash })
          } catch (_err) {
            // Intentionally swallowed: receipt fetch may fail for pending/dropped txs, status will be 'unknown'
          }

          transactions.push({
            hash: tx.hash,
            blockNumber: tx.blockNumber ?? 0n,
            from: tx.from,
            to: tx.to,
            value: formatUnits(tx.value, SUPPORTED_CHAINS[chainId].nativeDecimals),
            gasUsed: receipt?.gasUsed ?? null,
            timestamp: Number(block.timestamp),
            status: receipt ? (receipt.status === 'success' ? 'success' : 'reverted') : 'unknown',
          })

          if (transactions.length >= limit) break
        }
      }
    } catch (_err) {
      // Intentionally swallowed: individual block fetch may fail (RPC rate limit), continue with next block
      continue
    }
  }

  return transactions
}
