import { NextRequest, NextResponse } from 'next/server'
import { getWalletBalance, getTokenHoldings, getRecentTransactions } from '@/lib/web3/on-chain-tracker'

export const revalidate = 300 // Cache 5 minutes

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ address: string }> }
) {
  const { address } = await params
  const searchParams = request.nextUrl.searchParams
  const chainId = parseInt(searchParams.get('chainId') || '1', 10)

  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return NextResponse.json({ error: 'Invalid Ethereum address' }, { status: 400 })
  }

  try {
    const [balance, tokens, transactions] = await Promise.all([
      getWalletBalance(address, chainId),
      getTokenHoldings(address, chainId),
      getRecentTransactions(address, chainId, 10),
    ])

    return NextResponse.json(
      {
        balance: {
          ...balance,
          nativeBalanceRaw: balance.nativeBalanceRaw.toString(),
        },
        tokens: tokens.map((t) => ({
          ...t,
          balanceRaw: t.balanceRaw.toString(),
        })),
        transactions: transactions.map((tx) => ({
          ...tx,
          blockNumber: tx.blockNumber.toString(),
          gasUsed: tx.gasUsed?.toString() ?? null,
        })),
      },
      {
        headers: {
          'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=60',
        },
      }
    )
  } catch (error) {
    console.error('Wallet API error:', error)
    return NextResponse.json(
      { error: 'Failed to fetch wallet data' },
      { status: 500 }
    )
  }
}
