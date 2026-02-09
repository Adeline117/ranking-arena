import { NextRequest, NextResponse } from 'next/server'
import { getRecentTransactions, getWalletBalance, getTokenHoldings } from '@/lib/web3/on-chain-tracker'
import { analyzeTransactions, computeTokenDistribution } from '@/lib/web3/wallet-analytics'
import logger from '@/lib/logger'

export const revalidate = 300

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ address: string }> }
) {
  const { address } = await params
  const searchParams = request.nextUrl.searchParams
  const chainId = parseInt(searchParams.get('chainId') || '1', 10)

  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return NextResponse.json({ error: '无效的以太坊地址' }, { status: 400 })
  }

  try {
    const [balance, transactions, holdings] = await Promise.all([
      getWalletBalance(address, chainId),
      getRecentTransactions(address, chainId, 50),
      getTokenHoldings(address, chainId),
    ])

    const analytics = analyzeTransactions(transactions, address)
    const tokenDistribution = computeTokenDistribution(holdings)

    return NextResponse.json(
      {
        address,
        chainId,
        nativeSymbol: balance.nativeSymbol,
        currentBalance: parseFloat(balance.nativeBalance),
        ...analytics,
        tokenDistribution,
        note: 'PnL 为近似值，基于近期链上交易数据分析。',
      },
      {
        headers: {
          'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=60',
        },
      }
    )
  } catch (error) {
    logger.error('PnL API error:', error)
    return NextResponse.json(
      { error: '计算 PnL 失败' },
      { status: 500 }
    )
  }
}
