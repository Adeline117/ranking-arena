import { NextRequest, NextResponse } from 'next/server'
import { getRecentTransactions, getWalletBalance } from '@/lib/web3/on-chain-tracker'

export const revalidate = 300

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
    const [balance, transactions] = await Promise.all([
      getWalletBalance(address, chainId),
      getRecentTransactions(address, chainId, 50),
    ])

    const addr = address.toLowerCase()

    // Simple PnL: sum outflows vs inflows in native token
    let totalInflow = 0
    let totalOutflow = 0
    let txCount = 0

    for (const tx of transactions) {
      const value = parseFloat(tx.value)
      if (value === 0) continue
      txCount++

      if (tx.to?.toLowerCase() === addr) {
        totalInflow += value
      }
      if (tx.from.toLowerCase() === addr) {
        totalOutflow += value
      }
    }

    const netFlow = totalInflow - totalOutflow
    const currentBalance = parseFloat(balance.nativeBalance)

    return NextResponse.json(
      {
        address,
        chainId,
        nativeSymbol: balance.nativeSymbol,
        currentBalance,
        totalInflow,
        totalOutflow,
        netFlow,
        analyzedTransactions: txCount,
        note: 'PnL is approximate, based on recent on-chain transactions only.',
      },
      {
        headers: {
          'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=60',
        },
      }
    )
  } catch (error) {
    console.error('PnL API error:', error)
    return NextResponse.json(
      { error: 'Failed to calculate PnL' },
      { status: 500 }
    )
  }
}
