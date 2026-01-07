'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'

import TopNav from './components/Layout/TopNav'
import RankingTable, { type Trader } from './components/Features/RankingTable'
import PostFeed from './components/Features/PostFeed'
import MarketPanel from './components/Features/MarketPanel'
import Card from './components/UI/Card'
import CompareTraders from './components/Features/CompareTraders'
import { Box } from './components/Base'
import { useLanguage } from './components/Utils/LanguageProvider'

/* =====================
   Page
===================== */

export default function HomePage() {
  const { t } = useLanguage()
  
  /* ---------- auth ---------- */
  const [email, setEmail] = useState<string | null>(null)

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setEmail(data.user?.email ?? null)
    })
  }, [])

  /* ---------- ranking flow ---------- */
  const [traders, setTraders] = useState<Trader[]>([])
  const [loadingTraders, setLoadingTraders] = useState(true)

  useEffect(() => {
    const load = async () => {
      setLoadingTraders(true)

      // 优化：并行查询所有数据源，大幅提升加载速度
      const startTime = performance.now()
      
      // 并行查询所有数据源的最新时间戳
      const [binanceLatest, web3Latest, bybitLatest, bitgetLatest, mexcLatest, coinexLatest] = await Promise.all([
        supabase
          .from('trader_snapshots')
          .select('captured_at')
          .eq('source', 'binance')
          .order('captured_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
        supabase
          .from('trader_snapshots')
          .select('captured_at')
          .eq('source', 'binance_web3')
          .order('captured_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
        supabase
          .from('trader_snapshots')
          .select('captured_at')
          .eq('source', 'bybit')
          .order('captured_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
        supabase
          .from('trader_snapshots')
          .select('captured_at')
          .eq('source', 'bitget')
          .order('captured_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
        supabase
          .from('trader_snapshots')
          .select('captured_at')
          .eq('source', 'mexc')
          .order('captured_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
        supabase
          .from('trader_snapshots')
          .select('captured_at')
          .eq('source', 'coinex')
          .order('captured_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
      ])

      const latestBinanceTime = binanceLatest.data?.captured_at
      const latestWeb3Time = web3Latest.data?.captured_at
      const latestBybitTime = bybitLatest.data?.captured_at
      const latestBitgetTime = bitgetLatest.data?.captured_at
      const latestMexcTime = mexcLatest.data?.captured_at
      const latestCoinexTime = coinexLatest.data?.captured_at

      // 并行查询所有数据源的最新快照数据（只查询最新时间戳的数据，限制100条）
      const [binanceResult, web3Result, bybitResult, bitgetResult, mexcResult, coinexResult] = await Promise.all([
        latestBinanceTime
          ? supabase
              .from('trader_snapshots')
              .select('source_trader_id, rank, roi, followers, pnl, win_rate')
              .eq('source', 'binance')
              .eq('captured_at', latestBinanceTime)
              .order('rank', { ascending: true })
              .limit(100)
          : Promise.resolve({ data: [], error: null }),
        latestWeb3Time
          ? supabase
              .from('trader_snapshots')
              .select('source_trader_id, rank, roi, followers, pnl, win_rate')
              .eq('source', 'binance_web3')
              .eq('captured_at', latestWeb3Time)
              .order('rank', { ascending: true })
              .limit(100)
          : Promise.resolve({ data: [], error: null }),
        latestBybitTime
          ? supabase
              .from('trader_snapshots')
              .select('source_trader_id, rank, roi, followers, pnl, win_rate')
              .eq('source', 'bybit')
              .eq('captured_at', latestBybitTime)
              .order('rank', { ascending: true })
              .limit(100)
          : Promise.resolve({ data: [], error: null }),
        latestBitgetTime
          ? supabase
              .from('trader_snapshots')
              .select('source_trader_id, rank, roi, followers, pnl, win_rate')
              .eq('source', 'bitget')
              .eq('captured_at', latestBitgetTime)
              .order('rank', { ascending: true })
              .limit(100)
          : Promise.resolve({ data: [], error: null }),
        latestMexcTime
          ? supabase
              .from('trader_snapshots')
              .select('source_trader_id, rank, roi, followers, pnl, win_rate')
              .eq('source', 'mexc')
              .eq('captured_at', latestMexcTime)
              .order('rank', { ascending: true })
              .limit(100)
          : Promise.resolve({ data: [], error: null }),
        latestCoinexTime
          ? supabase
              .from('trader_snapshots')
              .select('source_trader_id, rank, roi, followers, pnl, win_rate')
              .eq('source', 'coinex')
              .eq('captured_at', latestCoinexTime)
              .order('rank', { ascending: true })
              .limit(100)
          : Promise.resolve({ data: [], error: null }),
      ])

      const finalBinanceSnapshots = (binanceResult.data || []) as any[]
      const finalWeb3Snapshots = (web3Result.data || []) as any[]
      const finalBybitSnapshots = (bybitResult.data || []) as any[]
      const finalBitgetSnapshots = (bitgetResult.data || []) as any[]
      const finalMexcSnapshots = (mexcResult.data || []) as any[]
      const finalCoinexSnapshots = (coinexResult.data || []) as any[]

      console.log(`[ranking] ✅ 并行查询完成: binance=${finalBinanceSnapshots.length}, web3=${finalWeb3Snapshots.length}, bybit=${finalBybitSnapshots.length}, bitget=${finalBitgetSnapshots.length}, mexc=${finalMexcSnapshots.length}, coinex=${finalCoinexSnapshots.length}`)
      
      // 调试信息：检查 Bitget 数据
      if (finalBitgetSnapshots.length === 0) {
        console.log(`[ranking] ⚠️ Bitget: 没有数据`)
        if (bitgetLatest.data) {
          console.log(`[ranking] ⚠️ Bitget: 最新时间戳存在: ${latestBitgetTime}, 但查询结果为空`)
          if (bitgetResult.error) {
            console.error(`[ranking] ❌ Bitget 查询错误:`, bitgetResult.error)
          }
        } else {
          console.log(`[ranking] ⚠️ Bitget: 数据库中没有 Bitget 数据，需要先运行脚本导入数据`)
          console.log(`[ranking] 💡 提示: 运行 node scripts/import_bitget_90d_roi.mjs 来导入 Bitget 数据`)
        }
      } else {
        console.log(`[ranking] ✅ Bitget: 找到 ${finalBitgetSnapshots.length} 条数据`)
        console.log(`[ranking] 📋 Bitget 前5条:`, finalBitgetSnapshots.slice(0, 5).map(s => ({ id: s.source_trader_id, roi: s.roi, rank: s.rank })))
      }
      
      // 调试信息：检查 Bitget 数据
      if (finalBitgetSnapshots.length === 0) {
        console.log(`[ranking] ⚠️ Bitget: 没有数据`)
        if (bitgetLatest.data) {
          console.log(`[ranking] ⚠️ Bitget: 最新时间戳存在: ${latestBitgetTime}, 但查询结果为空`)
        } else {
          console.log(`[ranking] ⚠️ Bitget: 数据库中没有 Bitget 数据，需要先运行脚本导入数据`)
        }
      } else {
        console.log(`[ranking] ✅ Bitget: 找到 ${finalBitgetSnapshots.length} 条数据`)
      }

      // 收集所有需要查询 handle 的交易员ID
      const allTraderIds = [
        ...finalBinanceSnapshots.map(s => ({ id: s.source_trader_id, source: 'binance' })),
        ...finalWeb3Snapshots.map(s => ({ id: s.source_trader_id, source: 'binance_web3' })),
        ...finalBybitSnapshots.map(s => ({ id: s.source_trader_id, source: 'bybit' })),
        ...finalBitgetSnapshots.map(s => ({ id: s.source_trader_id, source: 'bitget' })),
        ...finalMexcSnapshots.map(s => ({ id: s.source_trader_id, source: 'mexc' })),
        ...finalCoinexSnapshots.map(s => ({ id: s.source_trader_id, source: 'coinex' })),
      ]

      // 并行查询所有 handles（一次性查询所有数据源）
      const handleQueries = await Promise.all([
        finalBinanceSnapshots.length > 0
          ? supabase
              .from('trader_sources')
              .select('source_trader_id, handle')
              .eq('source', 'binance')
              .in('source_trader_id', finalBinanceSnapshots.map(s => s.source_trader_id))
          : Promise.resolve({ data: [], error: null }),
        finalWeb3Snapshots.length > 0
          ? supabase
              .from('trader_sources')
              .select('source_trader_id, handle')
              .eq('source', 'binance_web3')
              .in('source_trader_id', finalWeb3Snapshots.map(s => s.source_trader_id))
          : Promise.resolve({ data: [], error: null }),
        finalBybitSnapshots.length > 0
          ? supabase
              .from('trader_sources')
              .select('source_trader_id, handle')
              .eq('source', 'bybit')
              .in('source_trader_id', finalBybitSnapshots.map(s => s.source_trader_id))
          : Promise.resolve({ data: [], error: null }),
        finalBitgetSnapshots.length > 0
          ? supabase
              .from('trader_sources')
              .select('source_trader_id, handle')
              .eq('source', 'bitget')
              .in('source_trader_id', finalBitgetSnapshots.map(s => s.source_trader_id))
          : Promise.resolve({ data: [], error: null }),
        finalMexcSnapshots.length > 0
          ? supabase
              .from('trader_sources')
              .select('source_trader_id, handle')
              .eq('source', 'mexc')
              .in('source_trader_id', finalMexcSnapshots.map(s => s.source_trader_id))
          : Promise.resolve({ data: [], error: null }),
        finalCoinexSnapshots.length > 0
          ? supabase
              .from('trader_sources')
              .select('source_trader_id, handle')
              .eq('source', 'coinex')
              .in('source_trader_id', finalCoinexSnapshots.map(s => s.source_trader_id))
          : Promise.resolve({ data: [], error: null }),
      ])

      const binanceHandles = new Map<string, string>()
      handleQueries[0].data?.forEach((s: any) => {
        if (s.handle && s.handle.trim() !== '') {
          binanceHandles.set(s.source_trader_id, s.handle)
        }
      })

      const web3Handles = new Map<string, string>()
      handleQueries[1].data?.forEach((s: any) => {
        if (s.handle && s.handle.trim() !== '') {
          web3Handles.set(s.source_trader_id, s.handle)
        }
      })

      const bybitHandles = new Map<string, string>()
      handleQueries[2].data?.forEach((s: any) => {
        if (s.handle && s.handle.trim() !== '') {
          bybitHandles.set(s.source_trader_id, s.handle)
        }
      })

      const bitgetHandles = new Map<string, string>()
      handleQueries[3].data?.forEach((s: any) => {
        if (s.handle && s.handle.trim() !== '') {
          bitgetHandles.set(s.source_trader_id, s.handle)
        }
      })

      const mexcHandles = new Map<string, string>()
      handleQueries[4].data?.forEach((s: any) => {
        if (s.handle && s.handle.trim() !== '') {
          mexcHandles.set(s.source_trader_id, s.handle)
        }
      })

      const coinexHandles = new Map<string, string>()
      handleQueries[5].data?.forEach((s: any) => {
        if (s.handle && s.handle.trim() !== '') {
          coinexHandles.set(s.source_trader_id, s.handle)
        }
      })

      // 合并所有数据
      let allTradersData: Trader[] = []

      finalBinanceSnapshots.forEach((item: any) => {
        const handle = binanceHandles.get(item.source_trader_id)
        const displayHandle = handle && handle.trim() !== '' ? handle : item.source_trader_id
        allTradersData.push({
          id: item.source_trader_id,
          handle: displayHandle,
          roi: item.roi || 0,
          pnl: item.pnl !== null && item.pnl !== undefined ? item.pnl : undefined,
          win_rate: item.win_rate !== null && item.win_rate !== undefined ? item.win_rate : 0,
          volume_90d: undefined,
          avg_buy_90d: undefined,
          followers: item.followers || 0,
          source: 'binance',
        })
      })

      finalWeb3Snapshots.forEach((item: any) => {
        const handle = web3Handles.get(item.source_trader_id)
        const displayHandle = handle && handle.trim() !== '' ? handle : item.source_trader_id
        allTradersData.push({
          id: item.source_trader_id,
          handle: displayHandle,
          roi: item.roi || 0,
          pnl: item.pnl !== null && item.pnl !== undefined ? item.pnl : undefined,
          win_rate: item.win_rate !== null && item.win_rate !== undefined ? item.win_rate : 0,
          volume_90d: undefined,
          avg_buy_90d: undefined,
          followers: item.followers || 0,
          source: 'binance_web3',
        })
      })

      finalBybitSnapshots.forEach((item: any) => {
        const handle = bybitHandles.get(item.source_trader_id)
        const displayHandle = handle && handle.trim() !== '' ? handle : item.source_trader_id
        allTradersData.push({
          id: item.source_trader_id,
          handle: displayHandle,
          roi: item.roi || 0,
          pnl: item.pnl !== null && item.pnl !== undefined ? item.pnl : undefined,
          win_rate: item.win_rate !== null && item.win_rate !== undefined ? item.win_rate : 0,
          volume_90d: undefined,
          avg_buy_90d: undefined,
          followers: item.followers || 0,
          source: 'bybit',
        })
      })

      finalBitgetSnapshots.forEach((item: any) => {
        const handle = bitgetHandles.get(item.source_trader_id)
        const displayHandle = handle && handle.trim() !== '' ? handle : item.source_trader_id
        allTradersData.push({
          id: item.source_trader_id,
          handle: displayHandle,
          roi: item.roi || 0,
          pnl: item.pnl !== null && item.pnl !== undefined ? item.pnl : undefined,
          win_rate: item.win_rate !== null && item.win_rate !== undefined ? item.win_rate : 0,
          volume_90d: undefined,
          avg_buy_90d: undefined,
          followers: item.followers || 0,
          source: 'bitget',
        })
      })

      finalMexcSnapshots.forEach((item: any) => {
        const handle = mexcHandles.get(item.source_trader_id)
        const displayHandle = handle && handle.trim() !== '' ? handle : item.source_trader_id
        allTradersData.push({
          id: item.source_trader_id,
          handle: displayHandle,
          roi: item.roi || 0,
          pnl: item.pnl !== null && item.pnl !== undefined ? item.pnl : undefined,
          win_rate: item.win_rate !== null && item.win_rate !== undefined ? item.win_rate : 0,
          volume_90d: undefined,
          avg_buy_90d: undefined,
          followers: item.followers || 0,
          source: 'mexc',
        })
      })

      finalCoinexSnapshots.forEach((item: any) => {
        const handle = coinexHandles.get(item.source_trader_id)
        const displayHandle = handle && handle.trim() !== '' ? handle : item.source_trader_id
        allTradersData.push({
          id: item.source_trader_id,
          handle: displayHandle,
          roi: item.roi || 0,
          pnl: item.pnl !== null && item.pnl !== undefined ? item.pnl : undefined,
          win_rate: item.win_rate !== null && item.win_rate !== undefined ? item.win_rate : 0,
          volume_90d: undefined,
          avg_buy_90d: undefined,
          followers: item.followers || 0,
          source: 'coinex',
        })
      })

      // Deduplicate and sort all combined data
      // 如果同一个交易员在多个数据源都存在，保留 ROI 更高的那个
      const uniqueTradersMap = new Map<string, Trader>()
      allTradersData.forEach((item: Trader) => {
        const traderId = item.id
        const existing = uniqueTradersMap.get(traderId)
        // Keep the one with higher ROI if duplicate
        if (!existing || item.roi > existing.roi) {
          uniqueTradersMap.set(traderId, item)
        }
      })

      const tradersData: Trader[] = Array.from(uniqueTradersMap.values())
        .sort((a, b) => b.roi - a.roi) // Sort by ROI descending
        .slice(0, 100) // Keep only top 100

      console.log('[ranking] 📊 Final Summary:', {
        allTradersDataCount: allTradersData.length,
        uniqueTradersCount: uniqueTradersMap.size,
        finalTradersCount: tradersData.length,
        binanceCount: allTradersData.filter(t => t.source === 'binance').length,
        web3Count: allTradersData.filter(t => t.source === 'binance_web3').length,
        bybitCount: allTradersData.filter(t => t.source === 'bybit').length,
        bitgetCount: allTradersData.filter(t => t.source === 'bitget').length,
        mexcCount: allTradersData.filter(t => t.source === 'mexc').length,
        coinexCount: allTradersData.filter(t => t.source === 'coinex').length,
        top5: tradersData.slice(0, 5).map(t => ({ id: t.id, handle: t.handle, roi: t.roi, source: t.source }))
      })

      const loadTime = performance.now() - startTime
      console.log(`[ranking] ⚡ 加载耗时: ${loadTime.toFixed(0)}ms`)
      console.log(`[ranking] 📈 Total traders: ${tradersData.length} (binance: ${allTradersData.filter(t => t.source === 'binance').length}, web3: ${allTradersData.filter(t => t.source === 'binance_web3').length}, bybit: ${allTradersData.filter(t => t.source === 'bybit').length}, bitget: ${allTradersData.filter(t => t.source === 'bitget').length}, mexc: ${allTradersData.filter(t => t.source === 'mexc').length}, coinex: ${allTradersData.filter(t => t.source === 'coinex').length})`)

      if (tradersData.length === 0) {
        console.error('[ranking] ❌ ERROR: No traders data found!')
      } else {
        console.log(`[ranking] ✅ Successfully loaded ${tradersData.length} traders`)
      }

      setTraders(tradersData)
      setLoadingTraders(false)
    }

    load()
    
    // 每5分钟自动刷新一次数据
    const interval = setInterval(() => {
      load()
    }, 5 * 60 * 1000) // 5分钟 = 300000毫秒
    
    return () => clearInterval(interval)
  }, [email])

  /* ---------- trader compare ---------- */
  const [compareTraders, setCompareTraders] = useState<Trader[]>([])

  return (
    <Box
      style={{
        minHeight: '100vh',
        background: tokens.colors.bg.primary,
        color: tokens.colors.text.primary,
      }}
    >
      {/* 顶部导航 */}
      <TopNav email={email} />

      {/* 主体 */}
      <Box
        as="main"
        px={4}
        py={6}
        style={{
          maxWidth: 1200,
          margin: '0 auto',
        }}
      >
        <Box
          style={{
            display: 'grid',
            gridTemplateColumns: '320px 1fr 280px',
            gap: tokens.spacing[4],
          }}
        >
          {/* 左：热门讨论 */}
          <Box as="section">
            <Card title={t('hotDiscussion')}>
              <PostFeed />
            </Card>
            <Link
              href="/groups"
              style={{
                display: 'block',
                marginTop: tokens.spacing[3],
                textAlign: 'center',
                padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
                background: 'rgba(139, 111, 168, 0.1)',
                color: '#8b6fa8',
                borderRadius: tokens.radius.md,
                border: '1px solid rgba(139, 111, 168, 0.3)',
                textDecoration: 'none',
                fontSize: '14px',
                fontWeight: 700,
                transition: 'all 0.2s ease',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'rgba(139, 111, 168, 0.2)'
                e.currentTarget.style.borderColor = 'rgba(139, 111, 168, 0.5)'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'rgba(139, 111, 168, 0.1)'
                e.currentTarget.style.borderColor = 'rgba(139, 111, 168, 0.3)'
              }}
            >
              {t('more')} →
            </Link>
          </Box>

          {/* 中：排名流（产品核心） */}
          <Box as="section">
            <RankingTable
              traders={traders}
              loading={loadingTraders}
              loggedIn={!!email}
              source={traders.length > 0 ? traders[0].source : 'binance_web3'}
            />
          </Box>

          {/* 右：市场 */}
          <Box as="section">
            <MarketPanel />
          </Box>
        </Box>
      </Box>

      {/* 交易者对比面板 */}
      {compareTraders.length > 0 && (
        <CompareTraders
          traders={compareTraders}
          onRemove={(id) => setCompareTraders(compareTraders.filter((t) => t.id !== id))}
          onClear={() => setCompareTraders([])}
        />
      )}
    </Box>
  )
}
