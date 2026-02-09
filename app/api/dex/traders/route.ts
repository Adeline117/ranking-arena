import { NextRequest, NextResponse } from 'next/server'
import {
  fetchAllDexTraders,
  fetchUniswapTopTraders,
  fetchPancakeSwapTopTraders,
  type DexTrader,
} from '@/lib/web3/dex-tracker'
import logger from '@/lib/logger'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

type SortField = 'volume' | 'txCount' | 'pnl'

const SORT_FN: Record<SortField, (a: DexTrader, b: DexTrader) => number> = {
  volume: (a, b) => b.totalVolumeUSD - a.totalVolumeUSD,
  txCount: (a, b) => b.txCount - a.txCount,
  pnl: (a, b) => b.profitEstimate - a.profitEstimate,
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = req.nextUrl
    const dex = searchParams.get('dex') as 'uniswap' | 'pancakeswap' | null
    const chain = searchParams.get('chain') as 'ethereum' | 'bsc' | null
    const sortBy = (searchParams.get('sortBy') as SortField) || 'volume'
    const limit = Math.min(Number(searchParams.get('limit')) || 50, 200)

    let traders: DexTrader[]

    if (dex === 'uniswap') {
      traders = await fetchUniswapTopTraders(limit)
    } else if (dex === 'pancakeswap') {
      traders = await fetchPancakeSwapTopTraders(limit)
    } else {
      traders = await fetchAllDexTraders(limit)
    }

    if (chain) {
      traders = traders.filter((t) => t.chain === chain)
    }

    const sortFn = SORT_FN[sortBy] ?? SORT_FN.volume
    traders.sort(sortFn)

    return NextResponse.json({ traders, count: traders.length })
  } catch (err) {
    logger.error('[dex/traders] Error:', err)
    return NextResponse.json(
      { error: 'Failed to fetch DEX traders' },
      { status: 500 },
    )
  }
}
