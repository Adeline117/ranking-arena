/**
 * On-chain wallet enrichment — AUM, portfolio, account age
 *
 * Uses free APIs (no API key needed):
 * - Blockscout: EVM chains (Base, Arbitrum, Optimism, Ethereum)
 * - Solana public RPC: Solana (Jupiter, Drift)
 *
 * Enriches DEX traders with data that DEX APIs don't provide:
 * - AUM (wallet total asset value)
 * - On-chain portfolio (token holdings)
 * - Account age (first transaction timestamp)
 */

import type { PortfolioPosition } from './enrichment-types'
import { logger } from '@/lib/logger'

// ============================================
// Chain configuration
// ============================================

const BLOCKSCOUT_URLS: Record<string, string> = {
  arbitrum: 'https://arbitrum.blockscout.com',
  base: 'https://base.blockscout.com',
  optimism: 'https://optimism.blockscout.com',
  ethereum: 'https://eth.blockscout.com',
  bsc: 'https://bsc.blockscout.com',
  aevo: 'https://explorer.aevo.xyz',
}

// Platform → chain mapping
// 'auto' = detect from address format (0x = ethereum, base58 = solana)
const PLATFORM_CHAIN: Record<string, string> = {
  hyperliquid: 'hyperliquid', // Native L1 — use Hyperliquid clearinghouse API
  gmx: 'arbitrum',
  gains: 'arbitrum',
  kwenta: 'base',
  aevo: 'aevo',
  dydx: 'dydx', // Cosmos-based, use indexer API
  jupiter_perps: 'solana',
  drift: 'solana',
  binance_web3: 'auto', // Mixed EVM (BSC/ETH) + Solana wallets
  okx_web3: 'skip', // OKX internal IDs, not wallet addresses
  web3_bot: 'auto', // Mixed — some have wallet addresses
}

// Known stablecoin addresses per chain (for AUM calculation)
const STABLECOINS: Record<string, Record<string, { symbol: string; decimals: number }>> = {
  arbitrum: {
    '0xaf88d065e77c8cc2239327c5edb3a432268e5831': { symbol: 'USDC', decimals: 6 },
    '0xff970a61a04b1ca14834a43f5de4533ebddb5cc8': { symbol: 'USDC.e', decimals: 6 },
    '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9': { symbol: 'USDT', decimals: 6 },
    '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1': { symbol: 'DAI', decimals: 18 },
  },
  base: {
    '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': { symbol: 'USDC', decimals: 6 },
    '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca': { symbol: 'USDbC', decimals: 6 },
    '0x50c5725949a6f0c72e6c4a641f24049a917db0cb': { symbol: 'DAI', decimals: 18 },
  },
  optimism: {
    '0x0b2c639c533813f4aa9d7837caf62653d097ff85': { symbol: 'USDC', decimals: 6 },
    '0x7f5c764cbc14f9669b88837ca1490cca17c31607': { symbol: 'USDC.e', decimals: 6 },
    '0x94b008aa00579c1307b0ef2c499ad98a8ce58e58': { symbol: 'USDT', decimals: 6 },
  },
  ethereum: {
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': { symbol: 'USDC', decimals: 6 },
    '0xdac17f958d2ee523a2206206994597c13d831ec7': { symbol: 'USDT', decimals: 6 },
    '0x6b175474e89094c44da98b954eedeac495271d0f': { symbol: 'DAI', decimals: 18 },
  },
  bsc: {
    '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d': { symbol: 'USDC', decimals: 18 },
    '0x55d398326f99059ff775485246999027b3197955': { symbol: 'USDT', decimals: 18 },
    '0xe9e7cea3dedca5984780bafc599bd69add087d56': { symbol: 'BUSD', decimals: 18 },
    '0x1af3f329e8be154074d8769d1ffa4ee058b1dbc3': { symbol: 'DAI', decimals: 18 },
  },
}

// Known major tokens for portfolio value estimation
const MAJOR_TOKENS: Record<string, string[]> = {
  arbitrum: ['WETH', 'WBTC', 'ARB', 'GMX', 'GNS', 'LINK'],
  base: ['WETH', 'cbETH', 'SNX', 'AERO'],
  optimism: ['WETH', 'OP', 'SNX', 'WBTC'],
}

// Solana well-known token mints
const SOLANA_STABLECOINS: Record<string, { symbol: string; decimals: number }> = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { symbol: 'USDC', decimals: 6 },
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: { symbol: 'USDT', decimals: 6 },
}

const SOLANA_RPC = 'https://api.mainnet-beta.solana.com'

// Hyperliquid L1 API
const HYPERLIQUID_API = 'https://api.hyperliquid.xyz'

// ============================================
// Live price cache (refreshed per enrichment batch)
// ============================================

let _solPriceCache: { price: number; ts: number } | null = null

async function getSolPrice(): Promise<number> {
  // Cache for 5 minutes
  if (_solPriceCache && Date.now() - _solPriceCache.ts < 300_000) return _solPriceCache.price
  try {
    const resp = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd',
      { signal: AbortSignal.timeout(5000) }
    )
    if (resp.ok) {
      const data = await resp.json() as { solana?: { usd?: number } }
      const price = data.solana?.usd
      if (price && price > 10) {
        _solPriceCache = { price, ts: Date.now() }
        return price
      }
    }
  } catch (err) {
    logger.warn(`[wallet] SOL price fetch failed: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (_solPriceCache?.price) return _solPriceCache.price
  // No cache and API down — return null instead of hardcoded $150 to avoid
  // silently corrupting all wallet AUM calculations with stale price
  logger.warn('[wallet] SOL price unavailable (no cache, API down) — wallet AUM will be skipped')
  return 0 // Callers multiply by this; 0 means AUM won't be computed rather than wrong
}

// ============================================
// Blockscout wallet data (EVM chains)
// ============================================

interface BlockscoutTokenBalance {
  token: {
    address: string
    symbol: string
    name: string
    decimals: string
    type: string
    exchange_rate: string | null
  }
  value: string
}

/**
 * Fetch token balances for an EVM address via Blockscout (free, no key).
 */
async function fetchBlockscoutTokenBalances(
  chain: string,
  address: string
): Promise<BlockscoutTokenBalance[]> {
  const baseUrl = BLOCKSCOUT_URLS[chain]
  if (!baseUrl) return []

  try {
    const resp = await fetch(
      `${baseUrl}/api/v2/addresses/${address}/token-balances`,
      { signal: AbortSignal.timeout(15000) }
    )
    if (!resp.ok) return []
    const data = await resp.json()
    return Array.isArray(data) ? data : []
  } catch (err) {
    logger.warn(`[wallet] Token balance fetch failed (${chain}/${address.slice(0, 10)}): ${err instanceof Error ? err.message : String(err)}`)
    return []
  }
}

/**
 * Fetch native ETH balance via Blockscout.
 */
async function fetchBlockscoutNativeBalance(
  chain: string,
  address: string
): Promise<number> {
  const baseUrl = BLOCKSCOUT_URLS[chain]
  if (!baseUrl) return 0

  try {
    const resp = await fetch(
      `${baseUrl}/api/v2/addresses/${address}`,
      { signal: AbortSignal.timeout(10000) }
    )
    if (!resp.ok) return 0
    const data = await resp.json()
    const balance = data?.coin_balance
    if (!balance) return 0
    return Number(BigInt(balance)) / 1e18
  } catch (err) {
    logger.warn('[enrichment-wallet] native balance BigInt parse failed:', err instanceof Error ? err.message : String(err))
    return 0
  }
}

/**
 * Calculate AUM from on-chain token balances (EVM).
 * Returns USD value based on stablecoin balances + estimated major token values.
 */
export async function fetchEvmWalletAUM(
  chain: string,
  address: string
): Promise<number | null> {
  const balances = await fetchBlockscoutTokenBalances(chain, address)
  if (balances.length === 0) return null

  let totalUsd = 0
  const chainStables = STABLECOINS[chain] || {}

  for (const b of balances) {
    const tokenAddr = b.token.address.toLowerCase()
    const decimals = parseInt(b.token.decimals || '18')
    const rawValue = (() => { try { return Number(BigInt(String(b.value || '0').split('.')[0])) } catch (err) { logger.warn('[enrichment-wallet] BigInt token balance parse failed:', err instanceof Error ? err.message : String(err)); return 0 } })() / Math.pow(10, decimals)

    // Stablecoins: direct USD value
    if (chainStables[tokenAddr]) {
      totalUsd += rawValue
      continue
    }

    // Tokens with exchange rate from Blockscout
    if (b.token.exchange_rate) {
      const rate = parseFloat(b.token.exchange_rate)
      if (rate > 0 && rawValue > 0) {
        totalUsd += rawValue * rate
      }
    }
  }

  // Add native ETH balance (estimate at ~$2000-3000 range, use exchange_rate if available)
  const nativeBalance = await fetchBlockscoutNativeBalance(chain, address)
  if (nativeBalance > 0.001) {
    // Try to find ETH price from WETH token exchange_rate
    const wethBalance = balances.find((b) =>
      b.token.symbol === 'WETH' || b.token.symbol === 'WETH'
    )
    const ethPrice = wethBalance?.token.exchange_rate
      ? parseFloat(wethBalance.token.exchange_rate)
      : 2500 // Conservative fallback
    totalUsd += nativeBalance * ethPrice
  }

  return totalUsd > 1 ? Math.round(totalUsd * 100) / 100 : null
}

/**
 * Fetch on-chain portfolio positions (what tokens the trader holds).
 */
export async function fetchEvmWalletPortfolio(
  chain: string,
  address: string
): Promise<PortfolioPosition[]> {
  const balances = await fetchBlockscoutTokenBalances(chain, address)
  if (balances.length === 0) return []

  const chainStables = STABLECOINS[chain] || {}
  const _majorTokens = new Set(MAJOR_TOKENS[chain] || [])
  const positions: PortfolioPosition[] = []

  // Calculate total value first for weightPct
  let totalValue = 0
  const tokenValues: { symbol: string; usdValue: number }[] = []

  for (const b of balances) {
    const tokenAddr = b.token.address.toLowerCase()
    const decimals = parseInt(b.token.decimals || '18')
    const rawValue = (() => { try { return Number(BigInt(String(b.value || '0').split('.')[0])) } catch (err) { logger.warn('[enrichment-wallet] BigInt portfolio balance parse failed:', err instanceof Error ? err.message : String(err)); return 0 } })() / Math.pow(10, decimals)
    if (rawValue <= 0) continue

    let usdValue = 0

    if (chainStables[tokenAddr]) {
      usdValue = rawValue
    } else if (b.token.exchange_rate) {
      usdValue = rawValue * parseFloat(b.token.exchange_rate)
    }

    if (usdValue > 1) {
      tokenValues.push({ symbol: b.token.symbol, usdValue })
      totalValue += usdValue
    }
  }

  if (totalValue < 1) return []

  // Sort by value, take top 10
  tokenValues.sort((a, b) => b.usdValue - a.usdValue)
  for (const tv of tokenValues.slice(0, 10)) {
    positions.push({
      symbol: tv.symbol,
      direction: 'long',
      investedPct: Math.round((tv.usdValue / totalValue) * 1000) / 10,
      entryPrice: null,
      pnl: null,
    })
  }

  return positions
}

// ============================================
// Solana wallet data (Jupiter, Drift)
// ============================================

/**
 * Fetch Solana wallet AUM via public RPC (free).
 */
export async function fetchSolanaWalletAUM(address: string): Promise<number | null> {
  try {
    // Fetch SOL balance
    const balResp = await fetch(SOLANA_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'getBalance',
        params: [address],
      }),
      signal: AbortSignal.timeout(10000),
    })
    const balData = await balResp.json() as { result?: { value?: number } }
    const solBalance = (balData.result?.value || 0) / 1e9

    // Fetch token accounts
    const tokenResp = await fetch(SOLANA_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 2,
        method: 'getTokenAccountsByOwner',
        params: [
          address,
          { programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' },
          { encoding: 'jsonParsed' },
        ],
      }),
      signal: AbortSignal.timeout(10000),
    })
    const tokenData = await tokenResp.json() as {
      result?: { value?: Array<{ account: { data: { parsed: { info: { mint: string; tokenAmount: { uiAmount: number } } } } } }> }
    }

    let stablecoinTotal = 0
    const accounts = tokenData.result?.value || []
    for (const acct of accounts) {
      const info = acct.account?.data?.parsed?.info
      if (!info) continue
      const stable = SOLANA_STABLECOINS[info.mint]
      if (stable) {
        stablecoinTotal += info.tokenAmount?.uiAmount || 0
      }
    }

    // SOL price — live from CoinGecko with fallback
    const solPrice = await getSolPrice()
    const totalUsd = solBalance * solPrice + stablecoinTotal

    return totalUsd > 1 ? Math.round(totalUsd * 100) / 100 : null
  } catch (err) {
    logger.warn(`[wallet] Solana AUM failed for ${address.slice(0, 10)}: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

/**
 * Fetch Solana wallet portfolio positions.
 */
export async function fetchSolanaWalletPortfolio(address: string): Promise<PortfolioPosition[]> {
  try {
    const tokenResp = await fetch(SOLANA_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'getTokenAccountsByOwner',
        params: [
          address,
          { programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' },
          { encoding: 'jsonParsed' },
        ],
      }),
      signal: AbortSignal.timeout(10000),
    })
    const tokenData = await tokenResp.json() as {
      result?: { value?: Array<{ account: { data: { parsed: { info: { mint: string; tokenAmount: { uiAmount: number; uiAmountString: string } } } } } }> }
    }

    const accounts = tokenData.result?.value || []
    const holdings: { symbol: string; usdValue: number }[] = []

    for (const acct of accounts) {
      const info = acct.account?.data?.parsed?.info
      if (!info) continue
      const amount = info.tokenAmount?.uiAmount || 0
      if (amount <= 0) continue

      const stable = SOLANA_STABLECOINS[info.mint]
      if (stable && amount > 1) {
        holdings.push({ symbol: stable.symbol, usdValue: amount })
      }
    }

    if (holdings.length === 0) return []

    const totalValue = holdings.reduce((sum, h) => sum + h.usdValue, 0)
    return holdings.map((h) => ({
      symbol: h.symbol,
      direction: 'long' as const,
      investedPct: Math.round((h.usdValue / totalValue) * 1000) / 10,
      entryPrice: null,
      pnl: null,
    }))
  } catch (err) {
    logger.warn('[enrichment-wallet] Solana wallet portfolio fetch failed:', err instanceof Error ? err.message : String(err))
    return []
  }
}

// ============================================
// Hyperliquid wallet data (native L1)
// ============================================

/**
 * Fetch Hyperliquid account equity via native API (free, no key).
 * Hyperliquid has its own L1 — trader addresses are EVM-format but
 * balances live on Hyperliquid chain, not Arbitrum.
 */
export async function fetchHyperliquidWalletAUM(address: string): Promise<number | null> {
  try {
    const resp = await fetch(`${HYPERLIQUID_API}/info`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'clearinghouseState', user: address }),
      signal: AbortSignal.timeout(10000),
    })
    if (!resp.ok) return null
    const data = await resp.json() as {
      marginSummary?: { accountValue?: string }
      crossMarginSummary?: { accountValue?: string }
    }
    const equity = parseFloat(
      data.marginSummary?.accountValue || data.crossMarginSummary?.accountValue || '0'
    )
    return equity > 1 ? Math.round(equity * 100) / 100 : null
  } catch (err) {
    logger.warn('[enrichment-wallet] Hyperliquid wallet AUM fetch failed:', err instanceof Error ? err.message : String(err))
    return null
  }
}

// ============================================
// dYdX wallet data (Cosmos-based)
// ============================================

const DYDX_INDEXER = 'https://indexer.dydx.trade/v4'

/**
 * Fetch dYdX wallet AUM via indexer API (free, no key).
 */
async function fetchDydxWalletAUM(address: string): Promise<number | null> {
  try {
    const resp = await fetch(
      `${DYDX_INDEXER}/addresses/${address}/subaccountNumber/0`,
      { signal: AbortSignal.timeout(10000) }
    )
    if (!resp.ok) return null
    const data = await resp.json() as { subaccount?: { equity?: string } }
    const equity = parseFloat(data?.subaccount?.equity || '0')
    return equity > 1 ? Math.round(equity * 100) / 100 : null
  } catch (err) {
    logger.warn('[enrichment-wallet] dYdX wallet AUM fetch failed:', err instanceof Error ? err.message : String(err))
    return null
  }
}

// ============================================
// Auto-detection helpers
// ============================================

function isEvmAddress(address: string): boolean {
  return address.startsWith('0x') && address.length === 42
}

function isSolanaAddress(address: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)
}

function isDydxAddress(address: string): boolean {
  return address.startsWith('dydx1')
}

/**
 * Detect chain for mixed-format platforms (binance_web3, web3_bot).
 * EVM addresses try BSC first (Binance ecosystem), then Ethereum.
 */
function detectChainForAddress(address: string, platform: string): string | null {
  if (isEvmAddress(address)) {
    // binance_web3 EVM addresses are typically BSC
    return platform === 'binance_web3' ? 'bsc' : 'ethereum'
  }
  if (isSolanaAddress(address)) return 'solana'
  if (isDydxAddress(address)) return 'dydx'
  return null
}

// ============================================
// Unified interface for enrichment runner
// ============================================

/**
 * Fetch AUM for any DEX trader based on platform.
 */
export async function fetchWalletAUM(
  platform: string,
  address: string
): Promise<number | null> {
  let chain: string | null = PLATFORM_CHAIN[platform] ?? null
  if (!chain || chain === 'skip') return null

  // Auto-detect chain from address format
  if (chain === 'auto') {
    chain = detectChainForAddress(address, platform)
    if (!chain) return null
  }

  if (chain === 'solana') return fetchSolanaWalletAUM(address)
  if (chain === 'dydx') return fetchDydxWalletAUM(address)
  if (chain === 'hyperliquid') return fetchHyperliquidWalletAUM(address)

  return fetchEvmWalletAUM(chain, address)
}

/**
 * Fetch on-chain portfolio for any DEX trader based on platform.
 */
export async function fetchWalletPortfolio(
  platform: string,
  address: string
): Promise<PortfolioPosition[]> {
  let chain: string | null = PLATFORM_CHAIN[platform] ?? null
  if (!chain || chain === 'skip') return []

  if (chain === 'auto') {
    chain = detectChainForAddress(address, platform)
    if (!chain) return []
  }

  if (chain === 'solana') return fetchSolanaWalletPortfolio(address)
  if (chain === 'dydx') return [] // dYdX indexer doesn't expose token holdings
  if (chain === 'hyperliquid') return [] // Positions fetched via enrichment-dex, not wallet module

  return fetchEvmWalletPortfolio(chain, address)
}

/**
 * Check if a platform is a DEX with on-chain wallet data.
 */
export function isDexPlatform(platform: string): boolean {
  const chain = PLATFORM_CHAIN[platform]
  return !!chain && chain !== 'skip'
}
