'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'

import TopNav from './components/Layout/TopNav'
import RankingTable, { type Trader } from './components/Features/RankingTable'
import PostFeed from './components/Features/PostFeed'
import MarketPanel from './components/Features/MarketPanel'
import Card from './components/UI/Card'
import CompareTraders from './components/Features/CompareTraders'
import { Box } from './components/Base'

/* =====================
   Page
===================== */

export default function HomePage() {
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

      // 从 trader_snapshots 获取最新的 ROI Top 100 数据
      // 先获取最新的 captured_at，然后查询该批次的数据
      const { data: latestSnapshot, error: latestError } = await supabase
        .from('trader_snapshots')
        .select('captured_at')
        .eq('source', 'binance')
        .order('captured_at', { ascending: false })
        .limit(1)
        .single()

      if (latestError || !latestSnapshot) {
        console.error('[ranking] latest snapshot error:', latestError)
        setTraders([])
        setLoadingTraders(false)
        return
      }

      // 查询该批次的数据（先查询 snapshots，再查询 sources）
      const { data: snapshots, error: snapshotsError } = await supabase
        .from('trader_snapshots')
        .select('source_trader_id, rank, roi, followers')
        .eq('source', 'binance')
        .eq('captured_at', latestSnapshot.captured_at)
        .order('rank', { ascending: true })
        .limit(email ? 100 : 50)

      if (snapshotsError) {
        console.error('[ranking] snapshots error:', snapshotsError)
        setTraders([])
        setLoadingTraders(false)
        return
      }

      if (!snapshots || snapshots.length === 0) {
        console.log('[ranking] No snapshots found')
        setTraders([])
        setLoadingTraders(false)
        return
      }

      // 获取所有 source_trader_id 对应的 handle
      const traderIds = snapshots.map((s: any) => s.source_trader_id)
      const { data: sources, error: sourcesError } = await supabase
        .from('trader_sources')
        .select('source_trader_id, handle')
        .eq('source', 'binance')
        .in('source_trader_id', traderIds)

      if (sourcesError) {
        console.error('[ranking] sources error:', sourcesError)
        // 即使 sources 查询失败，也使用 snapshots 数据，只是 handle 用 source_trader_id
      }

      // 创建 handle 映射
      const handleMap = new Map<string, string>()
      if (sources) {
        sources.forEach((s: any) => {
          handleMap.set(s.source_trader_id, s.handle)
        })
      }

      // 转换为 Trader 格式
      const tradersData: Trader[] = snapshots.map((item: any) => ({
        id: item.source_trader_id,
        handle: handleMap.get(item.source_trader_id) || item.source_trader_id,
        roi: item.roi || 0,
        win_rate: 0, // trader_snapshots 中没有 win_rate，暂时设为 0
        followers: item.followers || 0,
        source: 'binance', // 数据来源
      }))

      setTraders(tradersData)

      setLoadingTraders(false)
    }

    load()
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
            <Card title="热门讨论">
              <PostFeed />
            </Card>
          </Box>

          {/* 中：排名流（产品核心） */}
          <Box as="section">
            <RankingTable
              traders={traders}
              loading={loadingTraders}
              loggedIn={!!email}
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
