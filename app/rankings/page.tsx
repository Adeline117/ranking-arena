'use client'

/**
 * Rankings V2 Page
 * Uses /api/rankings endpoint with URL query params for window switching.
 * Pure DB read, fast rendering, stale indicators.
 */

import { Suspense } from 'react'
import { useSearchParams, useRouter, usePathname } from 'next/navigation'
import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useRankingsV2 } from '@/lib/hooks/useRankingsV2'
import TopNav from '@/app/components/layout/TopNav'
import MobileBottomNav from '@/app/components/layout/MobileBottomNav'
import DataStateWrapper from '@/app/components/ui/DataStateWrapper'
import { RankingSkeleton } from '@/app/components/ui/Skeleton'
import { Box } from '@/app/components/base'
import { getAvatarGradient, getAvatarInitial } from '@/lib/utils/avatar'
import { formatROI, formatPnL } from '@/app/components/ranking/utils'
import type { SnapshotWindow, RankedTraderV2, Platform } from '@/lib/types/trading-platform'

const WINDOWS: SnapshotWindow[] = ['7D', '30D', '90D']

const PLATFORM_LABELS: Record<string, string> = {
  // CEX 合约
  binance_futures: 'Binance 合约',
  bybit: 'Bybit',
  bitget_futures: 'Bitget 合约',
  okx_futures: 'OKX 合约',
  mexc: 'MEXC',
  htx_futures: 'HTX',
  weex: 'Weex',
  kucoin: 'KuCoin',
  coinex: 'CoinEx',
  // CEX 现货
  binance_spot: 'Binance 现货',
  bitget_spot: 'Bitget 现货',
  // 链上/DEX
  binance_web3: 'Binance Web3',
  okx_web3: 'OKX Web3',
  gmx: 'GMX',
  hyperliquid: 'Hyperliquid',
  dydx: 'dYdX',
}

const FILTER_PLATFORMS = Object.keys(PLATFORM_LABELS)

function RankingsContent() {
  const { language } = useLanguage()
  const isZh = language === 'zh'
  const searchParams = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()

  const activeWindow = (searchParams.get('window') as SnapshotWindow) || '90D'
  const activePlatform = searchParams.get('platform') || undefined

  const { data, error, isLoading, isStale } = useRankingsV2({
    window: activeWindow,
    platform: activePlatform as Platform | undefined,
  })

  const handleWindowChange = (w: SnapshotWindow) => {
    const params = new URLSearchParams(searchParams.toString())
    params.set('window', w)
    router.replace(`${pathname}?${params.toString()}`, { scroll: false })
  }

  const handlePlatformChange = (p: string | undefined) => {
    const params = new URLSearchParams(searchParams.toString())
    if (p) {
      params.set('platform', p)
    } else {
      params.delete('platform')
    }
    router.replace(`${pathname}?${params.toString()}`, { scroll: false })
  }

  return (
    <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      <TopNav email={null} />
      <div className="feed-main-content max-w-5xl mx-auto px-4 py-6" style={{ paddingBottom: 80 }}>
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-bold" style={{ color: tokens.colors.text.primary }}>
            {isZh ? '交易员排行榜' : 'Trader Rankings'}
          </h1>
          <div className="flex items-center gap-3">
            {isStale && (
              <span
                className="px-2 py-1 rounded text-xs font-medium"
                style={{
                  backgroundColor: `${tokens.colors.accent.warning}20`,
                  color: tokens.colors.accent.warning,
                }}
              >
                {isZh ? '数据更新中' : 'Data updating'}
              </span>
            )}
            {data?.as_of && (
              <span className="text-xs" style={{ color: tokens.colors.text.tertiary }}>
                {new Date(data.as_of).toLocaleTimeString()}
              </span>
            )}
          </div>
        </div>

        <div className="flex flex-wrap gap-2 mb-4">
          {WINDOWS.map(w => (
            <button
              key={w}
              onClick={() => handleWindowChange(w)}
              className="px-4 py-2 rounded-lg text-sm font-medium transition-all"
              style={{
                backgroundColor: activeWindow === w ? tokens.colors.accent.brand : tokens.colors.bg.secondary,
                color: activeWindow === w ? '#fff' : tokens.colors.text.secondary,
              }}
            >
              {w}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap gap-2 mb-6">
          <button
            onClick={() => handlePlatformChange(undefined)}
            className="px-3 py-2 rounded-md text-xs font-medium transition-all touch-target-sm"
            style={{
              backgroundColor: !activePlatform ? tokens.colors.accent.brand + '30' : tokens.colors.bg.tertiary,
              color: !activePlatform ? tokens.colors.accent.brand : tokens.colors.text.tertiary,
              border: !activePlatform ? `1px solid ${tokens.colors.accent.brand}50` : `1px solid transparent`,
            }}
          >
            {isZh ? '全部' : 'All'}
          </button>
          {FILTER_PLATFORMS.map(p => (
            <button
              key={p}
              onClick={() => handlePlatformChange(p)}
              className="px-3 py-2 rounded-md text-xs font-medium transition-all touch-target-sm"
              style={{
                backgroundColor: activePlatform === p ? tokens.colors.accent.brand + '30' : tokens.colors.bg.tertiary,
                color: activePlatform === p ? tokens.colors.accent.brand : tokens.colors.text.tertiary,
                border: activePlatform === p ? `1px solid ${tokens.colors.accent.brand}50` : `1px solid transparent`,
              }}
            >
              {PLATFORM_LABELS[p]}
            </button>
          ))}
        </div>

        <DataStateWrapper
          isLoading={isLoading}
          error={error}
          isEmpty={!data?.traders?.length}
          emptyMessage={isZh ? '暂无排行榜数据' : 'No ranking data available'}
          loadingComponent={<RankingSkeleton />}
        >
          {data && data.traders.length > 0 && (
            <div className="rounded-xl overflow-x-auto" style={{ backgroundColor: tokens.colors.bg.secondary }}>
              <div>
                <div
                  className="grid ranking-table-grid gap-2 px-4 py-3 text-xs font-medium border-b"
                  style={{ color: tokens.colors.text.secondary, borderColor: tokens.colors.border.primary }}
                >
                  <div>#</div>
                  <div>{isZh ? '交易员' : 'Trader'}</div>
                  <div className="text-right">ROI</div>
                  <div className="text-right col-pnl">PnL</div>
                  <div className="text-right col-winrate">{isZh ? '胜率' : 'Win%'}</div>
                  <div className="text-right col-mdd">{isZh ? '回撤' : 'MDD'}</div>
                  <div className="text-right col-score">Score</div>
                </div>

                {data.traders.map((trader) => (
                  <TraderRow key={`${trader.platform}:${trader.trader_key}`} trader={trader} />
                ))}

                <div
                  className="px-4 py-3 text-xs text-center border-t"
                  style={{ color: tokens.colors.text.tertiary, borderColor: tokens.colors.border.primary }}
                >
                  {isZh ? `共 ${data.total_count} 名交易员` : `${data.total_count} traders total`}
                </div>
              </div>
            </div>
          )}
        </DataStateWrapper>
      </div>
      <MobileBottomNav />
    </Box>
  )
}

function TraderRow({ trader }: { trader: RankedTraderV2 }) {
  const metrics = trader.metrics
  const roiColor = metrics.roi >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error
  const traderUrl = `/trader/${encodeURIComponent(trader.trader_key)}?platform=${trader.platform}`

  return (
    <Link
      href={traderUrl}
      className="grid ranking-table-grid gap-2 px-4 py-3 items-center transition-all border-b last:border-b-0"
      style={{ borderColor: tokens.colors.border.primary + '40' }}
      onMouseEnter={(e) => { e.currentTarget.style.background = tokens.colors.bg.tertiary }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
    >
      <div className="text-sm font-medium" style={{ color: tokens.colors.text.secondary }}>
        {trader.rank <= 3 ? (
          <span className="text-lg">{trader.rank === 1 ? '🥇' : trader.rank === 2 ? '🥈' : '🥉'}</span>
        ) : (
          trader.rank
        )}
      </div>

      <div className="flex items-center gap-3 min-w-0">
        <div
          className="w-8 h-8 rounded-full flex-shrink-0 flex items-center justify-center overflow-hidden text-xs font-bold"
          style={{ background: trader.avatar_url ? undefined : getAvatarGradient(trader.trader_key) }}
        >
          {trader.avatar_url ? (
            <img src={trader.avatar_url} alt="" className="w-full h-full object-cover" />
          ) : (
            <span className="text-white">{getAvatarInitial(trader.display_name || trader.trader_key)}</span>
          )}
        </div>
        <div className="min-w-0">
          <div className="text-sm font-medium truncate" style={{ color: tokens.colors.text.primary }}>
            {trader.display_name || trader.trader_key.slice(0, 12)}
          </div>
          <div className="text-xs" style={{ color: tokens.colors.text.tertiary }}>
            {trader.platform.replace('_', ' ')}
          </div>
        </div>
      </div>

      <div className="text-right text-sm font-semibold" style={{ color: roiColor }}>
        {formatROI(metrics.roi)}
      </div>

      <div className="text-right text-sm col-pnl" style={{ color: tokens.colors.text.primary }}>
        {formatPnL(metrics.pnl)}
      </div>

      <div className="text-right text-sm col-winrate" style={{ color: tokens.colors.text.secondary }}>
        {metrics.win_rate != null ? `${metrics.win_rate.toFixed(1)}%` : '--'}
      </div>

      <div className="text-right text-sm col-mdd" style={{ color: tokens.colors.accent.error + 'cc' }}>
        {metrics.max_drawdown != null ? `-${metrics.max_drawdown.toFixed(1)}%` : '--'}
      </div>

      <div className="text-right col-score">
        {metrics.arena_score != null ? (
          <span
            className="text-sm font-bold px-2 py-0.5 rounded"
            style={{ backgroundColor: tokens.colors.accent.brand + '20', color: tokens.colors.accent.brand }}
          >
            {metrics.arena_score.toFixed(1)}
          </span>
        ) : (
          <span className="text-sm" style={{ color: tokens.colors.text.tertiary }}>--</span>
        )}
      </div>
    </Link>
  )
}

export default function RankingsPage() {
  return (
    <Suspense fallback={
      <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
        <TopNav email={null} />
        <div className="max-w-5xl mx-auto px-4 py-6">
          <RankingSkeleton />
        </div>
      </Box>
    }>
      <RankingsContent />
    </Suspense>
  )
}
