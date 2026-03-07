/**
 * Multi-Chain Asset Analysis API
 * GET /api/multi-chain/[address]?chains=solana,base,arbitrum,optimism
 *
 * Aggregates wallet balances and token holdings across multiple chains.
 * - EVM addresses (0x...) → queries Base, Arbitrum, Optimism (+ Ethereum)
 * - Solana addresses → queries Solana
 */

import { NextRequest, NextResponse } from 'next/server'
import { getWalletBalance, getTokenHoldings } from '@/lib/web3/on-chain-tracker'
import { SUPPORTED_CHAINS } from '@/lib/web3/chain-client'
import { isSolanaAddress, getSolanaWalletData } from '@/lib/web3/solana-client'
import logger from '@/lib/logger'

export const revalidate = 300

// Chain IDs for the target EVM chains
const MULTI_CHAIN_EVM: Record<string, number> = {
  ethereum: 1,
  base: 8453,
  arbitrum: 42161,
  optimism: 10,
}

const ALL_EVM_CHAIN_NAMES = Object.keys(MULTI_CHAIN_EVM)

interface ChainResult {
  chain: string
  chainId: number | null
  nativeBalance: string
  nativeSymbol: string
  tokens: Array<{
    symbol: string
    name: string
    balance: string
    contractAddress: string
  }>
  error?: string
}

function isEvmAddress(address: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(address)
}

async function fetchEvmChain(address: string, chainName: string, chainId: number): Promise<ChainResult> {
  try {
    const [balance, tokens] = await Promise.all([
      getWalletBalance(address, chainId),
      getTokenHoldings(address, chainId),
    ])

    return {
      chain: chainName,
      chainId,
      nativeBalance: balance.nativeBalance,
      nativeSymbol: balance.nativeSymbol,
      tokens: tokens.map((t) => ({
        symbol: t.symbol,
        name: t.name,
        balance: t.balance,
        contractAddress: t.contractAddress,
      })),
    }
  } catch (error) {
    const chainConfig = SUPPORTED_CHAINS[chainId]
    logger.warn(`Failed to fetch ${chainName} data for ${address}:`, error)
    return {
      chain: chainName,
      chainId,
      nativeBalance: '0',
      nativeSymbol: chainConfig?.nativeSymbol || 'ETH',
      tokens: [],
      error: `Failed to fetch ${chainName} data`,
    }
  }
}

async function fetchSolana(address: string): Promise<ChainResult> {
  try {
    const data = await getSolanaWalletData(address)
    return {
      chain: 'solana',
      chainId: null,
      nativeBalance: data.balance.nativeBalance,
      nativeSymbol: 'SOL',
      tokens: data.tokens.map((t) => ({
        symbol: t.symbol,
        name: t.name,
        balance: t.balance,
        contractAddress: t.mint,
      })),
    }
  } catch (error) {
    logger.warn(`Failed to fetch Solana data for ${address}:`, error)
    return {
      chain: 'solana',
      chainId: null,
      nativeBalance: '0',
      nativeSymbol: 'SOL',
      tokens: [],
      error: 'Failed to fetch Solana data',
    }
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ address: string }> }
) {
  const { address } = await params
  const searchParams = request.nextUrl.searchParams
  const chainsParam = searchParams.get('chains')

  // Detect address type
  const isEvm = isEvmAddress(address)
  const isSol = isSolanaAddress(address)

  if (!isEvm && !isSol) {
    return NextResponse.json(
      { error: 'Invalid address. Provide an EVM (0x...) or Solana address.' },
      { status: 400 }
    )
  }

  // Determine which chains to query
  let requestedChains: string[]
  if (chainsParam) {
    requestedChains = chainsParam.split(',').map((c) => c.trim().toLowerCase())
  } else if (isEvm) {
    requestedChains = ALL_EVM_CHAIN_NAMES
  } else {
    requestedChains = ['solana']
  }

  // Execute queries in parallel
  const promises: Promise<ChainResult>[] = []

  for (const chain of requestedChains) {
    if (chain === 'solana' && isSol) {
      promises.push(fetchSolana(address))
    } else if (MULTI_CHAIN_EVM[chain] && isEvm) {
      promises.push(fetchEvmChain(address, chain, MULTI_CHAIN_EVM[chain]))
    }
  }

  if (promises.length === 0) {
    return NextResponse.json(
      { error: 'No valid chain/address combination found.' },
      { status: 400 }
    )
  }

  const results = await Promise.all(promises)

  // Compute summary
  const totalTokenCount = results.reduce((sum, r) => sum + r.tokens.length, 0)
  const chainsWithBalance = results.filter(
    (r) => !r.error && (parseFloat(r.nativeBalance) > 0 || r.tokens.length > 0)
  ).length

  return NextResponse.json(
    {
      address,
      addressType: isEvm ? 'evm' : 'solana',
      queriedChains: requestedChains,
      summary: {
        totalChains: results.length,
        chainsWithBalance,
        totalTokenTypes: totalTokenCount,
      },
      chains: results,
    },
    {
      headers: {
        'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=60',
      },
    }
  )
}
