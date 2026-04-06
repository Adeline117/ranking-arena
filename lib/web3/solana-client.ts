/**
 * Solana Chain Client
 * Provides read-only access to Solana for wallet balances and SPL token holdings.
 */

import {
  Connection,
  PublicKey,
  LAMPORTS_PER_SOL,
  type ParsedAccountData,
} from '@solana/web3.js'

const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com'

let connectionInstance: Connection | null = null

function getConnection(): Connection {
  if (!connectionInstance) {
    connectionInstance = new Connection(SOLANA_RPC_URL, 'confirmed')
  }
  return connectionInstance
}

// Well-known SPL tokens for metadata fallback
const KNOWN_SPL_TOKENS: Record<string, { symbol: string; name: string; decimals: number }> = {
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': { symbol: 'USDC', name: 'USD Coin', decimals: 6 },
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': { symbol: 'USDT', name: 'Tether USD', decimals: 6 },
  'So11111111111111111111111111111111111111112': { symbol: 'WSOL', name: 'Wrapped SOL', decimals: 9 },
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So': { symbol: 'mSOL', name: 'Marinade Staked SOL', decimals: 9 },
  'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263': { symbol: 'BONK', name: 'Bonk', decimals: 5 },
  'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN': { symbol: 'JUP', name: 'Jupiter', decimals: 6 },
  '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs': { symbol: 'ETH', name: 'Wrapped Ether (Wormhole)', decimals: 8 },
  'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3': { symbol: 'PYTH', name: 'Pyth Network', decimals: 6 },
  'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL': { symbol: 'JTO', name: 'Jito', decimals: 9 },
  'WENWENvqqNya429ubCdR81ZmD69brwQaaBYY6p3LCpk': { symbol: 'WEN', name: 'Wen', decimals: 5 },
}

export interface SolanaBalance {
  address: string
  chain: 'solana'
  nativeBalance: string
  nativeSymbol: 'SOL'
  nativeBalanceRaw: number
  nativeBalanceUsd: null // Would need price feed
}

export interface SolanaTokenHolding {
  address: string
  chain: 'solana'
  mint: string
  symbol: string
  name: string
  decimals: number
  balance: string
  balanceRaw: number
}

/**
 * Validate a Solana address.
 */
export function isSolanaAddress(address: string): boolean {
  try {
    const key = new PublicKey(address)
    return PublicKey.isOnCurve(key.toBytes())
  } catch (_err) {
    // Intentionally swallowed: invalid base58 or off-curve key means not a valid Solana address
    return false
  }
}

/**
 * Get SOL balance for a wallet.
 */
export async function getSolanaBalance(address: string): Promise<SolanaBalance> {
  const conn = getConnection()
  const pubkey = new PublicKey(address)
  const lamports = await conn.getBalance(pubkey)

  return {
    address,
    chain: 'solana',
    nativeBalance: (lamports / LAMPORTS_PER_SOL).toFixed(9),
    nativeSymbol: 'SOL',
    nativeBalanceRaw: lamports,
    nativeBalanceUsd: null,
  }
}

/**
 * Get SPL token holdings for a wallet.
 */
export async function getSolanaTokenHoldings(address: string): Promise<SolanaTokenHolding[]> {
  const conn = getConnection()
  const pubkey = new PublicKey(address)

  const tokenAccounts = await conn.getParsedTokenAccountsByOwner(pubkey, {
    programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
  })

  const holdings: SolanaTokenHolding[] = []

  for (const { account } of tokenAccounts.value) {
    const parsed = account.data as ParsedAccountData
    const info = parsed.parsed?.info
    if (!info) continue

    const mint: string = info.mint
    const amount = info.tokenAmount
    if (!amount || Number(amount.uiAmount) === 0) continue

    const known = KNOWN_SPL_TOKENS[mint]

    holdings.push({
      address,
      chain: 'solana',
      mint,
      symbol: known?.symbol || mint.slice(0, 6) + '...',
      name: known?.name || 'Unknown Token',
      decimals: amount.decimals,
      balance: String(amount.uiAmount),
      balanceRaw: Number(amount.amount),
    })
  }

  // Sort by balance descending (rough, since no USD price)
  holdings.sort((a, b) => Number(b.balance) - Number(a.balance))

  return holdings
}

/**
 * Get complete Solana wallet data.
 */
export async function getSolanaWalletData(address: string) {
  const [balance, tokens] = await Promise.all([
    getSolanaBalance(address),
    getSolanaTokenHoldings(address),
  ])

  return { balance, tokens }
}
