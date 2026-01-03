'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'
import TopNav from '@/app/components/Layout/TopNav'
import MarketPanel from '@/app/components/Features/MarketPanel'
import Card from '@/app/components/UI/Card'
import RankingTableCompact from '@/app/components/Features/RankingTableCompact'
import { Box, Text } from '@/app/components/Base'
import type { Trader } from '@/app/components/Features/RankingTable'

type Post = {
  id: number
  group: string
  title: string
  author: string
  time: string
  body: string
  comments: number
  likes: number
  hotScore?: number
  views?: number
}

export default function HotPage() {
  const [loggedIn, setLoggedIn] = useState(false)
  const [email, setEmail] = useState<string | null>(null)
  const [traders, setTraders] = useState<Trader[]>([])
  const [loadingTraders, setLoadingTraders] = useState(true)

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setEmail(data.user?.email ?? null)
      setLoggedIn(!!data.user)
    })
  }, [])

  useEffect(() => {
    const load = async () => {
      setLoadingTraders(true)
      const { data, error } = await supabase
        .from('trader_snapshots')
        .select(`
          source_trader_id,
          rank,
          roi,
          followers,
          trader_sources!inner(handle)
        `)
        .eq('source', 'binance')
        .order('rank', { ascending: true })
        .limit(10)

      if (!error && data) {
        const tradersData: Trader[] = data.map((item: any) => ({
          id: item.source_trader_id,
          handle: item.trader_sources?.handle || item.source_trader_id,
          roi: item.roi || 0,
          win_rate: 0,
          followers: item.followers || 0,
        }))
        setTraders(tradersData)
      } else {
        console.error('[hot ranking]', error)
        setTraders([])
      }
      setLoadingTraders(false)
    }
    load()
  }, [])

  // 热榜帖子（mock数据，后续接入真实数据）
  const posts: Post[] = useMemo(
    () => [
      {
        id: 11,
        group: 'BTC 内幕鲸鱼组',
        title: '今晚 8 点会不会假突破？我给出 3 个证据',
        author: 'zero_chill',
        comments: 212,
        likes: 1203,
        time: '2h',
        body: '证据 1：链上大额转入交易所明显增多；证据 2：永续资金费率开始抬头但现货成交跟不上；证据 3：关键阻力位附近挂单结构很"干净"。我的结论：如果 8 点前后放量但回踩不站稳，假突破概率更高。',
        hotScore: 98,
        views: 128000,
      },
      {
        id: 12,
        group: '合约爆仓幸存者',
        title: '"不设止损"不是勇敢，是数学不及格',
        author: 'night_whale',
        comments: 98,
        likes: 640,
        time: '4h',
        body: '很多人误以为"扛单"=强者，其实是把风险用时间放大。你只要想清楚：任何策略都有最大回撤，杠杆会把它乘上去。止损不是承认失败，是在保护你的下一次机会。',
        hotScore: 76,
        views: 100000,
      },
      {
        id: 14,
        group: '新手入坑区',
        title: '现货/合约/杠杆到底有什么区别？一句话讲明白',
        author: 'Alice',
        comments: 54,
        likes: 210,
        time: '9h',
        body: '现货：你真买了币；杠杆：你借钱放大现货仓位；合约：你买的是"价格涨跌的合约"，可以做空。新手最容易死在合约，因为它把波动、杠杆、强平规则都叠加了。',
        hotScore: 71,
        views: 103400,
      },
    ],
    []
  )

  const hotPosts = useMemo(() => {
    const sorted = [...posts].sort((a, b) => (b.hotScore ?? 0) - (a.hotScore ?? 0))
    return sorted
  }, [posts])

  const visibleHot = useMemo(() => {
    return loggedIn ? hotPosts : hotPosts.slice(0, 3) // 未登录只显示前3条
  }, [loggedIn, hotPosts])

  return (
    <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      <TopNav email={email} />

      <Box as="main" px={4} py={6} style={{ maxWidth: 1200, margin: '0 auto' }}>
        <Box style={{ display: 'grid', gridTemplateColumns: '260px 1fr 280px', gap: tokens.spacing[4] }}>
          {/* 左：排名前十 */}
          <Box as="section">
            <Card title="排名前十">
              <RankingTableCompact traders={traders} loading={loadingTraders} loggedIn={loggedIn} />
            </Card>
          </Box>

          {/* 中：热榜 */}
          <Box as="section">
            <Card title="热榜">
              <Text size="sm" color="secondary" style={{ marginBottom: tokens.spacing[3] }}>
                {loggedIn ? '已登录：显示全部' : '未登录：仅显示前3条'}
              </Text>
              <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
                {visibleHot.map((p, idx) => {
                  const rank = idx + 1
                  return (
                    <Link
                      key={p.id}
                      href={`/post/${p.id}`}
                      style={{ textDecoration: 'none' }}
                    >
                      <Box
                        bg="primary"
                        p={4}
                        radius="md"
                        border="primary"
                        style={{
                          cursor: 'pointer',
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.background = tokens.colors.bg.secondary
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.background = tokens.colors.bg.primary
                        }}
                      >
                        <Box style={{ display: 'flex', gap: tokens.spacing[2], marginBottom: tokens.spacing[2] }}>
                          <Text size="sm" weight="black" style={{ color: rank <= 3 ? tokens.colors.accent.warning : tokens.colors.text.secondary }}>
                            #{rank}
                          </Text>
                          <Text size="xs" color="secondary">{p.group}</Text>
                          <Text size="xs" color="tertiary">{(p.views ?? 0).toLocaleString()} 浏览</Text>
                        </Box>
                        <Text size="base" weight="bold" style={{ marginBottom: tokens.spacing[2] }}>
                          {p.title}
                        </Text>
                        <Text size="sm" color="secondary" style={{ marginBottom: tokens.spacing[2], lineHeight: 1.5 }}>
                          {p.body.slice(0, 100)}...
                        </Text>
                        <Box style={{ display: 'flex', gap: tokens.spacing[3], fontSize: tokens.typography.fontSize.xs, color: tokens.colors.text.tertiary }}>
                          <Text size="xs" color="tertiary">{p.author}</Text>
                          <Text size="xs" color="tertiary">{p.time}</Text>
                          <Text size="xs" color="tertiary">💬 {p.comments}</Text>
                          <Text size="xs" color="tertiary">👍 {p.likes}</Text>
                        </Box>
                      </Box>
                    </Link>
                  )
                })}
              </Box>
              {!loggedIn && (
                <Box style={{ marginTop: tokens.spacing[4], padding: tokens.spacing[3], textAlign: 'center' }}>
                  <Text size="sm" color="secondary">
                    想看全部热榜？
                    <Link href="/login" style={{ color: tokens.colors.accent.primary, textDecoration: 'none', marginLeft: tokens.spacing[1] }}>
                      登录 →
                    </Link>
                  </Text>
                </Box>
              )}
            </Card>
          </Box>

          {/* 右：市场 */}
          <Box as="section">
            <MarketPanel />
          </Box>
        </Box>
      </Box>
    </Box>
  )
}
