'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase/client'

import TopNav from '@/app/components/TopNav'
import MarketPanel from '@/app/components/MarketPanel'
import Card from '@/app/components/Card'

type Trader = {
  id: string
  handle: string
  roi: number
  win_rate: number
  followers: number
}

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

const ARENA_PURPLE = '#a855f7'

export default function HotPage() {
  // 登录态（用于限制未登录只看前 3 热榜）
  const [loggedIn, setLoggedIn] = useState(false)

  useEffect(() => {
    const run = async () => {
      const { data } = await supabase.auth.getUser()
      setLoggedIn(!!data.user)
    }
    run()
  }, [])

  // 左侧榜单：traders top10
  const [traders, setTraders] = useState<Trader[]>([])
  const [loadingTraders, setLoadingTraders] = useState(true)

  useEffect(() => {
    const run = async () => {
      setLoadingTraders(true)
      const { data, error } = await supabase
        .from('traders')
        .select('id, handle, roi, win_rate, followers')
        .order('roi', { ascending: false })
        .limit(10)

      if (error) {
        console.error(error)
        setTraders([])
      } else {
        setTraders((data ?? []) as Trader[])
      }
      setLoadingTraders(false)
    }
    run()
  }, [])

  // 热榜：先 mock，后面接你的帖子表
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
        body:
          '证据 1：链上大额转入交易所明显增多；证据 2：永续资金费率开始抬头但现货成交跟不上；证据 3：关键阻力位附近挂单结构很“干净”。\n\n我的结论：如果 8 点前后放量但回踩不站稳，假突破概率更高。策略上我会分批，先小仓试探，严格止损……',
        hotScore: 98,
        views: 128000,
      },
      {
        id: 12,
        group: '合约爆仓幸存者',
        title: '“不设止损”不是勇敢，是数学不及格',
        author: 'night_whale',
        comments: 98,
        likes: 640,
        time: '4h',
        body:
          '很多人误以为“扛单”=强者，其实是把风险用时间放大。\n\n你只要想清楚：任何策略都有最大回撤，杠杆会把它乘上去。\n止损不是承认失败，是在保护你的下一次机会。',
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
        body:
          '现货：你真买了币；\n杠杆：你借钱放大现货仓位；\n合约：你买的是“价格涨跌的合约”，可以做空。\n\n新手最容易死在合约，因为它把波动、杠杆、强平规则都叠加了。',
        hotScore: 71,
        views: 103400,
      },
      {
        id: 13,
        group: 'DeFi 长线仓位讨论区',
        title: 'ETH 质押收益到底算不算“无风险”？',
        author: 'alpha_fox',
        comments: 76,
        likes: 301,
        time: '6h',
        body:
          '从名义上看质押像“利息”，但它承担了协议风险、惩罚风险（slashing）、流动性风险、以及机会成本。\n\n更现实的问题是：你拿到的收益计价单位是 ETH，本身价格波动就已经把“无风险”否掉了。',
        hotScore: 64,
        views: 104000,
      },
    ],
    []
  )

  const hotPosts = useMemo(() => {
    const sorted = [...posts].sort((a, b) => (b.hotScore ?? 0) - (a.hotScore ?? 0))
    return sorted
  }, [posts])

  const visibleHot = useMemo(() => {
    return loggedIn ? hotPosts : hotPosts.slice(0, 3)
  }, [loggedIn, hotPosts])

  const [openPost, setOpenPost] = useState<Post | null>(null)

  return (
    <div style={{ minHeight: '100vh', background: '#060606', color: '#f2f2f2' }}>
      {/* ✅ 顶部：直接复用你现成的 TopNav（有搜索栏 + 用户信息） */}
      <TopNav />

      <main style={{ maxWidth: 1200, margin: '0 auto', padding: '18px 16px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '260px 1fr 280px', gap: 16 }}>
          {/* Left：排名前十 */}
          <section>
            <Card title="排名前十 (ROI)">
              {loadingTraders ? (
                <div style={{ fontSize: 13, color: '#a9a9a9' }}>加载中…</div>
              ) : traders.length === 0 ? (
                <div style={{ fontSize: 13, color: '#a9a9a9' }}>
                  暂无数据（检查 Supabase public.traders）
                </div>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr>
                      <th style={th}>Trader</th>
                      <th style={th}>ROI</th>
                    </tr>
                  </thead>
                  <tbody>
                    {traders.map((t, idx) => (
                      <tr key={t.id}>
                        <td style={td}>
                          <span style={{ color: '#777', marginRight: 6 }}>{idx + 1}</span>
                          <Link href={`/trader/${t.id}`} style={{ color: '#eaeaea', textDecoration: 'none' }}>
                            {t.handle}
                          </Link>
                        </td>
                        <td style={td}>
                          <span style={{ color: t.roi >= 0 ? '#7CFFB2' : '#FF7C7C' }}>
                            {Number(t.roi).toFixed(1)}%
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <div style={{ marginTop: 10, fontSize: 12, color: '#777' }}>未登录：热榜仅显示前 3 条</div>
            </Card>
          </section>

          {/* Center：热榜 */}
          <section>
            <div style={{ marginBottom: 10, fontSize: 13, color: '#a9a9a9' }}>
              热榜 {loggedIn ? '（已登录：全量）' : '（未登录：仅前 3 条）'}
            </div>

            {visibleHot.map((p, idx) => {
              const rank = idx + 1
              const rankColor = rank <= 3 ? '#f59e0b' : '#9ca3af'
              return (
                <div
                  key={p.id}
                  onClick={() => setOpenPost(p)}
                  style={{
                    border: '1px solid #1f1f1f',
                    borderRadius: 16,
                    background: '#0b0b0b',
                    padding: 14,
                    marginBottom: 12,
                    cursor: 'pointer',
                  }}
                >
                  <div style={{ display: 'flex', gap: 12 }}>
                    <div style={{ color: rankColor, fontWeight: 900 }}>#{rank}</div>
                    <div style={{ flex: 1 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                        <div style={{ fontSize: 12, color: ARENA_PURPLE }}>{p.group}</div>
                        <div style={{ fontSize: 12, color: '#777' }}>{(p.views ?? 0).toLocaleString()} views</div>
                      </div>

                      <div style={{ marginTop: 8, fontSize: 16, fontWeight: 950 }}>{p.title}</div>

                      <div style={{ marginTop: 8, fontSize: 13, color: '#cfcfcf', lineHeight: 1.5 }}>
                        {p.body.slice(0, 120)}…
                      </div>

                      <div style={{ marginTop: 10, fontSize: 12, color: '#777' }}>
                        {p.author} · {p.time} · 💬 {p.comments} · 👍 {p.likes}
                      </div>
                    </div>
                  </div>
                </div>
              )
            })}

            {!loggedIn ? (
              <div style={{ marginTop: 10, fontSize: 13, color: '#a9a9a9' }}>
                想看全部热榜？去登录解锁：
                <Link href="/login" style={{ color: ARENA_PURPLE, textDecoration: 'none', marginLeft: 6 }}>
                  Sign up / Login →
                </Link>
              </div>
            ) : null}
          </section>

          {/* Right：市场（复用你现成的组件） */}
          <section>
            <MarketPanel />
          </section>
        </div>
      </main>

      {/* 弹窗：热榜正文 */}
      {openPost ? (
        <Modal onClose={() => setOpenPost(null)}>
          <div style={{ fontSize: 12, color: ARENA_PURPLE }}>{openPost.group}</div>
          <div style={{ marginTop: 6, fontSize: 20, fontWeight: 950, lineHeight: 1.25 }}>{openPost.title}</div>
          <div style={{ marginTop: 8, fontSize: 12, color: '#777' }}>
            {openPost.author} · {openPost.time} · 💬 {openPost.comments} · 👍 {openPost.likes}
          </div>
          <div style={{ marginTop: 12, fontSize: 14, color: '#d6d6d6', lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>
            {openPost.body}
          </div>

          <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid #141414', display: 'flex', gap: 14, flexWrap: 'wrap' }}>
            <Action text="👍 赞同" onClick={() => alert('下一关：热榜正文赞同')} />
            <Action text="👎 反对" onClick={() => alert('下一关：热榜正文反对')} />
            <Action text="💬 评论" onClick={() => alert('下一关：热榜正文评论')} />
            <Action text="🔁 转发" onClick={() => alert('下一关：热榜正文转发')} />
          </div>
        </Modal>
      ) : null}
    </div>
  )
}

/* ---------- styles/components ---------- */

const th: React.CSSProperties = {
  textAlign: 'left',
  padding: '8px 6px',
  borderBottom: '1px solid #1f1f1f',
  color: '#a9a9a9',
  fontWeight: 700,
}

const td: React.CSSProperties = {
  padding: '8px 6px',
  borderBottom: '1px solid #141414',
  verticalAlign: 'top',
}

function Action(props: { text: string; onClick: () => void; active?: boolean }) {
  return (
    <button
      onClick={props.onClick}
      style={{
        border: 'none',
        background: 'transparent',
        color: props.active ? '#eaeaea' : '#a9a9a9',
        cursor: 'pointer',
        padding: 0,
        fontSize: 13,
        fontWeight: props.active ? 950 : 700,
      }}
    >
      {props.text}
    </button>
  )
}

function Modal(props: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div
      onClick={props.onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.65)',
        display: 'grid',
        placeItems: 'center',
        padding: 16,
        zIndex: 60,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(760px, 100%)',
          border: '1px solid #1f1f1f',
          borderRadius: 16,
          background: '#0b0b0b',
          padding: 16,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button onClick={props.onClose} style={{ border: 'none', background: 'transparent', color: '#bdbdbd', cursor: 'pointer', fontSize: 20 }}>
            ×
          </button>
        </div>
        {props.children}
      </div>
    </div>
  )
}
