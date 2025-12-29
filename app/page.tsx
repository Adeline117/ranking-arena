'use client'
const ARENA_GRADIENT = 'linear-gradient(135deg,#7c3aed,#a855f7)'
const ARENA_PURPLE = '#a855f7'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { supabase } from '../lib/supabase/client'

type Trader = {
  id: string
  handle: string
  roi: number
  win_rate: number
  followers: number
}

type Group = {
  id: number
  name: string
  subtitle: string
  badge?: string
  members?: number
  postsToday?: number
}

type PollChoice = 'bull' | 'bear' | 'wait'

type Post = {
  views?: number
  id: number
  group: string
  title: string
  author: string
  time: string
  body: string
  comments: number
  likes: number
  pollEnabled?: boolean // 1) 帖主自选，不一定每帖都有
  poll?: { bull: number; bear: number; wait: number }
  hotScore?: number
}

type MarketRow = {
  symbol: string
  price: string
  changePct: string
  direction: 'up' | 'down'
}

type TabKey = 'recommend' | 'season' | 'market' | 'groups' | 'hot'

function pollLabel(choice: PollChoice | 'tie') {
  if (choice === 'bull') return '看多'
  if (choice === 'bear') return '看空'
  return '观望'
}

function pollColor(choice: PollChoice | 'tie') {
  if (choice === 'bull') return '#7CFFB2'
  if (choice === 'bear') return '#FF7C7C'
  return '#A9A9A9'
}

function getPollWinner(poll?: { bull: number; bear: number; wait: number }): PollChoice | 'tie' {
  if (!poll) return 'tie'
  const arr: Array<[PollChoice, number]> = [
    ['bull', poll.bull],
    ['bear', poll.bear],
    ['wait', poll.wait],
  ]
  arr.sort((a, b) => b[1] - a[1])
  if (arr[0][1] === arr[1][1]) return 'tie'
  return arr[0][0]
}

export default function Home() {
  const [email, setEmail] = useState<string | null>(null)
  const [traders, setTraders] = useState<Trader[]>([])
  const [loadingTraders, setLoadingTraders] = useState(true)

  // 顶部 tab（5,7）
  const [tab, setTab] = useState<TabKey>('recommend')
  const [activeGroup, setActiveGroup] = useState<number | null>(null)

  // 搜索下拉（6）
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchText, setSearchText] = useState('')

  // 帖子展开全文
  const [expanded, setExpanded] = useState<Record<number, boolean>>({})

  // 评论展开（3）
  const [commentsOpen, setCommentsOpen] = useState<Record<number, boolean>>({})

  // 投票 state（1,2）
  const [pollState, setPollState] = useState<Record<number, { bull: number; bear: number; wait: number }>>({})
  const [myVote, setMyVote] = useState<Record<number, PollChoice | null>>({})

  // 赞同/反对 state（3）
  const [myReact, setMyReact] = useState<Record<number, 'up' | 'down' | null>>({})
  const [reactCounts, setReactCounts] = useState<Record<number, { up: number; down: number }>>({})

  // 热榜详情弹窗（7）
  const [hotModalPost, setHotModalPost] = useState<Post | null>(null)
  const [market, setMarket] = useState<MarketRow[]>([])
  const [marketLoading, setMarketLoading] = useState(true)
  const [marketError, setMarketError] = useState<string | null>(null)
  // 1) 右上角：当前用户
  useEffect(() => {
    const run = async () => {
      const { data } = await supabase.auth.getUser()
      setEmail(data.user?.email ?? null)
    }
    run()
  }, [])
  // ✅ 实时市场：每 3 秒刷新一次
useEffect(() => {
  let alive = true

  const load = async () => {
    try {
      setMarketLoading(true)
      const res = await fetch('/api/market', { cache: 'no-store' })
      const json = await res.json()
      if (!alive) return
      setMarket(json.rows ?? [])
    } catch (e) {
      if (!alive) return
      setMarket([])
    } finally {
      if (!alive) return
      setMarketLoading(false)
    }
  }

  load()
  const t = setInterval(load, 3000)
  return () => {
    alive = false
    clearInterval(t)
  }
}, [])
 // 2) 左侧榜单：从 traders 表拉数据
  useEffect(() => {
    const run = async () => {
      setLoadingTraders(true)
      const { data, error } = await supabase
        .from('traders')
        .select('id, handle, roi, win_rate, followers')
        .order('roi', { ascending: false })
        .limit(10)

      if (error) {
        console.error('Fetch traders error:', error)
        setTraders([])
      } else {
        setTraders((data ?? []) as Trader[])
      }
      setLoadingTraders(false)
    }
    run()
  }, [])

  const groups: Group[] = useMemo(
    () => [
      { id: 1, name: 'BTC 内幕鲸鱼组', subtitle: '链上异动｜大户跟踪', badge: '高危', members: 12800, postsToday: 87 },
      { id: 2, name: 'DeFi 长线仓位讨论区', subtitle: '质押/APR｜风险管理', badge: 'DeFi', members: 6600, postsToday: 42 },
      { id: 3, name: '合约爆仓幸存者', subtitle: '仓位控制｜止损纪律', badge: '合约', members: 9900, postsToday: 103 },
      { id: 4, name: '新手入坑区', subtitle: '从 0 到 1｜术语解释', badge: '新手', members: 15300, postsToday: 65 },
    ],
    []
  )

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
          '证据 1：链上大额转入交易所明显增多；证据 2：永续资金费率开始抬头但现货成交跟不上；证据 3：关键阻力位附近挂单结构很“干净”。我的结论：如果 8 点前后放量但回踩不站稳，假突破概率更高。策略上我会分批，先小仓试探，严格止损……',
        pollEnabled: true,
        poll: { bull: 4664, bear: 1200, wait: 888 },
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
          '很多人误以为“扛单”=强者，其实是把风险用时间放大。你只要想清楚：任何策略都有最大回撤，杠杆会把它乘上去。止损不是承认失败，是在保护你的下一次机会。',
        pollEnabled: true,
        poll: { bull: 520, bear: 980, wait: 300 },
        hotScore: 76,
        views: 100000,
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
          '从名义上看质押像“利息”，但它承担了协议风险、惩罚风险（slashing）、流动性风险、以及机会成本。更现实的问题是：你拿到的收益计价单位是 ETH，本身价格波动就已经把“无风险”否掉了。',
        pollEnabled: false, // 1) 这帖没有投票（但标题后面仍显示灰色观望）
        hotScore: 64,
        views: 104000,
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
          '现货：你真买了币；杠杆：你借钱放大现货仓位；合约：你买的是“价格涨跌的合约”，可以做空。新手最容易死在合约，因为它把波动、杠杆、强平规则都叠加了。',
        pollEnabled: true,
        poll: { bull: 180, bear: 120, wait: 900 },
        hotScore: 71,
        views: 103400,
      },
    ],
    []
  )

  const hotPosts = useMemo(() => {
    return [...posts]
      .sort((a, b) => (b.hotScore ?? 0) - (a.hotScore ?? 0))
      .slice(0, 10)
  }, [posts])

  // 初始化 poll / reaction 状态
  useEffect(() => {
    setPollState((prev) => {
      const next = { ...prev }
      for (const p of posts) {
        if (p.pollEnabled && p.poll && !next[p.id]) next[p.id] = p.poll
      }
      return next
    })
    setMyVote((prev) => {
      const next = { ...prev }
      for (const p of posts) {
        if (next[p.id] === undefined) next[p.id] = null
      }
      return next
    })
    setMyReact((prev) => {
      const next = { ...prev }
      for (const p of posts) {
        if (next[p.id] === undefined) next[p.id] = null
      }
      return next
    })
    setReactCounts((prev) => {
      const next = { ...prev }
      for (const p of posts) {
        if (!next[p.id]) next[p.id] = { up: p.likes, down: Math.floor(p.likes * 0.08) }
      }
      return next
    })
  }, [posts])

  // 2) 投票：点一次投，再点一次取消
  const toggleVote = (postId: number, choice: PollChoice) => {
    setPollState((prev) => {
      const current = prev[postId]
      if (!current) return prev

      const old = myVote[postId]
      const next = { ...current }

      if (old === choice) {
        // 取消
        next[choice] = Math.max(0, next[choice] - 1)
      } else {
        // 切换：先扣旧票（如果有），再加新票
        if (old) next[old] = Math.max(0, next[old] - 1)
        next[choice] = next[choice] + 1
      }
      return { ...prev, [postId]: next }
    })

    setMyVote((prev) => {
      const old = prev[postId]
      return { ...prev, [postId]: old === choice ? null : choice }
    })
  }

  // 3) 赞同/反对：可点，再点取消；互斥切换
  const toggleReact = (postId: number, dir: 'up' | 'down') => {
    setReactCounts((prev) => {
      const cur = prev[postId] ?? { up: 0, down: 0 }
      const mine = myReact[postId]
      let next = { ...cur }

      if (mine === dir) {
        // 取消
        next = { ...next, [dir]: Math.max(0, next[dir] - 1) }
      } else {
        // 切换：扣掉旧的，加新的
        if (mine) next = { ...next, [mine]: Math.max(0, next[mine] - 1) }
        next = { ...next, [dir]: next[dir] + 1 }
      }
      return { ...prev, [postId]: next }
    })

    setMyReact((prev) => {
      const mine = prev[postId]
      return { ...prev, [postId]: mine === dir ? null : dir }
    })
  }

  const toggleExpand = (postId: number) => setExpanded((prev) => ({ ...prev, [postId]: !prev[postId] }))
  const toggleComments = (postId: number) => setCommentsOpen((prev) => ({ ...prev, [postId]: !prev[postId] }))

  const filteredHot = useMemo(() => {
    const q = searchText.trim().toLowerCase()
    if (!q) return hotPosts
    return hotPosts.filter((p) => (p.title + p.group + p.author + p.body).toLowerCase().includes(q))
  }, [hotPosts, searchText])

  return (
    <div style={{ minHeight: '100vh', background: '#060606', color: '#f2f2f2' }}>
      {/* Top Nav */}
      <header
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 10,
          borderBottom: '1px solid #1f1f1f',
          background: 'rgba(8,8,8,0.9)',
          backdropFilter: 'blur(8px)',
        }}
      >
        <div
          style={{
            maxWidth: 1200,
            margin: '0 auto',
            padding: '12px 16px',
            display: 'flex',
            alignItems: 'center',
            gap: 14,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div
              style={{
                width: 34,
                height: 34,
                borderRadius: 10,
                background: ARENA_GRADIENT,
                display: 'grid',
                placeItems: 'center',
                fontWeight: 800,
              }}
            >
              A
            </div>
            <div style={{ lineHeight: 1.1 }}>
              <div style={{ fontWeight: 800, letterSpacing: 0.2 }}>Arena</div>
              <div style={{ fontSize: 12, color: '#a9a9a9' }}>Ranking Arena</div>
            </div>
          </div>

          {/* 5) 首页→推荐；讨论→小组 */}
          <nav style={{ display: 'flex', gap: 12, marginLeft: 10, fontSize: 13, color: '#cfcfcf' }}>
            <NavBtn active={tab === 'recommend'} onClick={() => setTab('recommend')}>推荐
            </NavBtn>
            <NavBtn active={tab === 'season'} onClick={() => setTab('season')}>赛季
            </NavBtn>
            <NavBtn active={tab === 'market'} onClick={() => setTab('market')}>市场
            </NavBtn>
            <NavBtn active={tab === 'groups'} onClick={() => setTab('groups')}>小组
            </NavBtn>
            <NavBtn active={tab === 'hot'} onClick={() => setTab('hot')}>热榜
            </NavBtn>
          </nav>

          <div style={{ flex: 1 }} />

          {/* 6) 搜索栏点击弹出热榜简化内容 */}
          <div style={{ width: 420, maxWidth: '45vw', position: 'relative' }}>
            <input
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              onFocus={() => setSearchOpen(true)}
              placeholder="搜索：帖子 / 小组 / 市场"
              style={{
                width: '100%',
                padding: '10px 12px',
                borderRadius: 12,
                border: '1px solid #1f1f1f',
                background: '#0b0b0b',
                color: '#eaeaea',
                outline: 'none',
                fontSize: 13,
              }}
            />

            {searchOpen ? (
              <div
                style={{
                  position: 'absolute',
                  top: 44,
                  left: 0,
                  right: 0,
                  border: '1px solid #1f1f1f',
                  borderRadius: 14,
                  background: '#0b0b0b',
                  overflow: 'hidden',
                  zIndex: 30,
                }}
              >
                <div style={{ padding: '10px 12px', borderBottom: '1px solid #141414', fontSize: 12, color: '#a9a9a9' }}>
                  热榜帖子（简化内容）
                </div>

                {filteredHot.slice(0, 6).map((p) => (
                  <button
                    key={p.id}
                    onClick={() => {
                      setHotModalPost(p)
                      setSearchOpen(false)
                    }}
                    style={{
                      width: '100%',
                      textAlign: 'left',
                      padding: '10px 12px',
                      border: 'none',
                      background: 'transparent',
                      cursor: 'pointer',
                      borderBottom: '1px solid #141414',
                      color: '#eaeaea',
                    }}
                  >
                    <div style={{ fontSize: 12,color: ARENA_PURPLE }}>{p.group}</div>
                    <div style={{ marginTop: 4, fontWeight: 900 }}>{p.title}</div>
                    <div style={{ marginTop: 6, fontSize: 12, color: '#a9a9a9', lineHeight: 1.4 }}>
                      {p.body.slice(0, 60)}…
                    </div>
                  </button>
                ))}

                <button
                  onClick={() => {
                    setTab('hot')
                    setSearchOpen(false)
                  }}
                  style={{
                    width: '100%',
                    padding: '10px 12px',
                    border: 'none',
                    background: '#0c0c0c',
                    cursor: 'pointer',
                    color: ARENA_PURPLE,
                    fontWeight: 900,
                    fontSize: 12,
                  }}
                >
                  去热榜 →
                </button>
              </div>
            ) : null}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {email ? (
              <>
                <div style={{ fontSize: 12, color: '#bdbdbd' }}>{email}</div>
                <Link href="/logout" style={{ fontSize: 12, color: ARENA_PURPLE, textDecoration: 'none' }}>
                  退出
                </Link>
              </>
            ) : (
              <Link
                href="/login"
                style={{
                  fontSize: 12,
                  color: '#0b0b0b',
                  background: '#eaeaea',
                  padding: '8px 10px',
                  borderRadius: 10,
                  textDecoration: 'none',
                  fontWeight: 700,
                }}
              >
                Sign up / Login
              </Link>
            )}
            <div style={{ position: 'relative' }}>
              <div
                title="profile"
                style={{
                  width: 34,
                  height: 34,
                  borderRadius: 999,
                  border: '1px solid #1f1f1f',
                  background: '#0c0c0c',
                  display: 'grid',
                  placeItems: 'center',
                  fontWeight: 800,
                  color: '#bdbdbd',
                }}
              >
                {email ? email.slice(0, 1).toUpperCase() : '?'}
              </div>
            
              {/* 未读小红点：先写死 1，后面接数据库 */}
              {1 > 0 && (
                <span
                  style={{
                    position: 'absolute',
                    top: -2,
                    left: -2,
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    background: ARENA_PURPLE,
                  }}
                />
              )}
            </div>
          </div>
        </div>
      </header>

      {/* 点击外面关闭搜索下拉 */}
      {searchOpen ? (
        <div
          onClick={() => setSearchOpen(false)}
          style={{ position: 'fixed', inset: 0, background: 'transparent', zIndex: 20 }}
        />
      ) : null}

      {/* Main */}
      <main style={{ maxWidth: 1200, margin: '0 auto', padding: '18px 16px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '260px 1fr 280px', gap: 16 }}>
          {/* Left：排行榜 + 左下角快捷入口（4） */}
          <section style={{ display: 'flex', flexDirection: 'column', gap: 12, minHeight: 520 }}>
            <Card title="赛季排行榜 (ROI)">
              {loadingTraders ? (
                <div style={{ fontSize: 13, color: '#a9a9a9' }}>加载中…</div>
              ) : traders.length === 0 ? (
                <div style={{ fontSize: 13, color: '#a9a9a9' }}>
                  还没有数据（或 Supabase 权限/表名不对）。
                  <div style={{ marginTop: 6, fontSize: 12, color: '#777' }}>检查：public.traders 是否有数据</div>
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
                          <span style={{ color: t.roi >= 0 ? '#7CFFB2' : '#FF7C7C' }}>{Number(t.roi).toFixed(1)}%</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <div style={{ marginTop: 10, fontSize: 12, color: '#777' }}>点击 trader 进入个人页（/trader/[id]）</div>
            </Card>

            {/* 4) 快捷入口放左下角 */}
            <div style={{ marginTop: 'auto' }}>
              <Card title="➕ 我的快捷入口">
                <div style={{ fontSize: 13, color: '#a9a9a9' }}>把你要做的功能拆成按钮，方便迭代。</div>
                <div style={{ height: 10 }} />
                <Link href="/" style={pillLink}>
                  刷新首页
                </Link>
                <Link href="/login" style={pillLink}>
                  去登录
                </Link>
              </Card>
            </div>
          </section>

          {/* Center：推荐/热榜 的内容（7） */}
          <section>
            {tab === 'hot' ? (
              <>
                <div style={{ marginBottom: 10, fontSize: 13, color: '#a9a9a9' }}>热榜（点击条目可查看后续内容）</div>
                {hotPosts.map((p, idx) => {
  const rank = idx + 1
  const rankColor = rank <= 3 ? '#f59e0b' : '#9ca3af'

  return (
    <div
      key={p.id}
      style={{
        border: '1px solid #1f1f1f',
        borderRadius: 16,
        background: '#0b0b0b',
        padding: 14,
        marginBottom: 12,
        cursor: 'pointer',
      }}
      onClick={() => setHotModalPost(p)}
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
            {p.author} · {p.time} · 💬 {p.comments}
          </div>
        </div>
      </div>
    </div>
  )
})}     
              </>
            ) : (
              <>
                <div style={{ marginBottom: 10, fontSize: 13, color: '#a9a9a9' }}>
                  推荐（可投票的帖才显示投票按钮；评论可展开）
                </div>

                {posts.map((p) => {
                  const isOpen = !!expanded[p.id]
                  const showPoll = !!p.pollEnabled
                  const poll = pollState[p.id]
                  const winner = showPoll && poll ? getPollWinner(poll) : 'tie' // 没投票：默认 tie -> 观望灰
                  const label = pollLabel(winner)
                  const color = pollColor(winner)

                  const previewLen = 90
                  const preview = p.body.length > previewLen ? p.body.slice(0, previewLen) + '…' : p.body

                  const reacts = reactCounts[p.id] ?? { up: p.likes, down: Math.floor(p.likes * 0.08) }
                  const mine = myReact[p.id]

                  return (
                    <div
                      key={p.id}
                      style={{
                        border: '1px solid #1f1f1f',
                        borderRadius: 16,
                        background: '#0b0b0b',
                        padding: 14,
                        marginBottom: 12,
                        position: 'relative',
                      }}
                    >
                      {/* 小组 / 作者 / 时间 */}
                      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
                        <div>
                          <div style={{ fontSize: 12, color: ARENA_PURPLE }}>{p.group}</div>
                          <div style={{ marginTop: 4, fontSize: 12, color: '#bdbdbd' }}>{p.author}</div>
                        </div>
                        <div style={{ fontSize: 12, color: '#777' }}>{p.time}</div>
                      </div>

                      {/* 1) 每个标题后面都有标签 */}
                      <div style={{ marginTop: 10, fontSize: 16, fontWeight: 950, letterSpacing: 0.2, lineHeight: 1.25 }}>
                        {p.title}{' '}
                        <span
                          style={{
                            fontSize: 12,
                            color,
                            fontWeight: 950,
                            border: '1px solid #1f1f1f',
                            padding: '2px 8px',
                            borderRadius: 999,
                            marginLeft: 6,
                          }}
                          title={showPoll ? '基于投票结果' : '该帖未开启投票，默认观望'}
                        >
                          {label}
                        </span>
                      </div>

                      {/* 正文预览 + 展开 */}
                      <div style={{ marginTop: 10, fontSize: 13, color: '#cfcfcf', lineHeight: 1.55 }}>
                        {isOpen ? p.body : preview}
                      </div>

                      <button
                        onClick={() => toggleExpand(p.id)}
                        style={{
                          marginTop: 10,
                          padding: '8px 10px',
                          borderRadius: 10,
                          border: '1px solid #1f1f1f',
                          background: '#0c0c0c',
                          color: '#eaeaea',
                          fontSize: 12,
                          cursor: 'pointer',
                        }}
                      >
                        {isOpen ? '收起' : '展开 · 看全文'}
                      </button>

                      {/* 3) 操作栏：赞同/反对/评论（可展开）/转发 */}
                      <div
                        style={{
                          marginTop: 12,
                          paddingTop: 12,
                          borderTop: '1px solid #141414',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 14,
                          fontSize: 13,
                          color: '#a9a9a9',
                          flexWrap: 'wrap',
                        }}
                      >
                        <Action
                          text={`👍 赞同 ${reacts.up}`}
                          active={mine === 'up'}
                          onClick={() => toggleReact(p.id, 'up')}
                        />
                        <Action
                          text={`👎 反对 ${reacts.down}`}
                          active={mine === 'down'}
                          onClick={() => toggleReact(p.id, 'down')}
                        />
                        <Action text={`💬 评论 ${p.comments}`} onClick={() => toggleComments(p.id)} />
                        <Action text="🔁 转发" onClick={() => alert('下一关：转发/分享')} />
                        <div style={{ flex: 1 }} />
                      </div>

                      {/* 评论展开区（3） */}
                      {commentsOpen[p.id] ? (
                        <div style={{ marginTop: 12, borderTop: '1px solid #141414', paddingTop: 12 }}>
                          <div style={{ fontWeight: 950, marginBottom: 8 }}>评论区（mock）</div>
                          <textarea
                            placeholder="写评论…"
                            style={{
                              width: '100%',
                              minHeight: 86,
                              resize: 'vertical',
                              padding: 12,
                              borderRadius: 14,
                              border: '1px solid #1f1f1f',
                              background: '#0c0c0c',
                              color: '#eaeaea',
                              outline: 'none',
                              fontSize: 13,
                              lineHeight: 1.6,
                            }}
                          />
                          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10 }}>
                            <button
                              onClick={() => alert('下一关：发表评论写入数据库')}
                              style={{
                                padding: '10px 12px',
                                borderRadius: 12,
                                border: '1px solid #1f1f1f',
                                background: ARENA_GRADIENT,
                                color: '#fff',
                                fontWeight: 950,
                                cursor: 'pointer',
                                fontSize: 12,
                              }}
                            >
                              发表评论
                            </button>
                          </div>
                        </div>
                      ) : null}

                      {/* 1,2) 投票：只有开启的帖才显示；点一次投票，再点一次取消 */}
                      {isOpen && showPoll && poll ? (
                        <div style={{ marginTop: 16 }}>
                          <div style={{ display: 'flex', gap: 12 }}>
                            <VoteBtn
                              active={myVote[p.id] === 'bull'}
                              onClick={() => toggleVote(p.id, 'bull')}
                            >
                              看多 {poll.bull}
                            </VoteBtn>
                      
                            <VoteBtn
                              active={myVote[p.id] === 'bear'}
                              onClick={() => toggleVote(p.id, 'bear')}
                            >
                              看空 {poll.bear}
                            </VoteBtn>
                      
                            <VoteBtn
                              active={myVote[p.id] === 'wait'}
                              onClick={() => toggleVote(p.id, 'wait')}
                            >
                              观望 {poll.wait}
                            </VoteBtn>
                          </div>
                        </div>
                      ) : null}                      
                    </div>
                  )
                })}
              </>
            )}
          </section>

          {/* Right：只要市场和小组（4） */}
          <section style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <Card title="市场">
  {marketLoading ? (
    <div style={{ fontSize: 13, color: '#a9a9a9' }}>加载实时行情…</div>
  ) : market.length === 0 ? (
    <div style={{ fontSize: 13, color: '#a9a9a9' }}>暂无行情数据（API 失败 / 限流）</div>
  ) : (
    market.map((m) => (
      <div
        key={m.symbol}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '10px 0',
          borderBottom: '1px solid #141414',
          fontSize: 13,
        }}
      >
        <div style={{ fontWeight: 950 }}>{m.symbol}</div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ color: '#eaeaea' }}>${m.price}</div>
          <div style={{ color: m.direction === 'up' ? '#7CFFB2' : '#FF7C7C', fontSize: 12 }}>
            {m.changePct}
          </div>
        </div>
      </div>
    ))
  )}

  <div style={{ marginTop: 10, fontSize: 12, color: '#777' }}>
    实时市场数据（每 3 秒刷新）
  </div>
</Card>


            <Card title="小组">
              {groups.map((g) => (
                <div
                key={g.id}
                onClick={() => {
                  setActiveGroup(g.id)
                  setTab('groups')
                }}
                style={{ padding: '10px 0', borderBottom: '1px solid #141414', cursor: 'pointer' }}>              
                 <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
  <div style={{ fontWeight: 950, color: ARENA_PURPLE }}>{g.name}</div>

  {g.badge ? (
    <span
      style={{
        fontSize: 11,
        color: '#0b0b0b',
        background: '#eaeaea',
        padding: '2px 6px',
        borderRadius: 999,
        fontWeight: 950,
      }}
    >
      {g.badge}
    </span>
  ) : null}

  <button
    onClick={() => alert(`下一关：加入小组 ${g.name}`)}
    style={{
      marginLeft: 'auto',
      padding: '6px 10px',
      borderRadius: 999,
      background: ARENA_PURPLE,
      color: '#fff',
      fontSize: 12,
      border: 'none',
      cursor: 'pointer',
      fontWeight: 900,
    }}
  >
    加入
  </button>
</div>
                  <div style={{ fontSize: 12, color: '#a9a9a9', marginTop: 4 }}>{g.subtitle}</div>
                  <div style={{ fontSize: 12, color: '#777', marginTop: 6 }}>
                    {g.members?.toLocaleString()} 成员 · 今日 {g.postsToday} 帖
                  </div>
                </div>
              ))}
              <button
                style={{
                  width: '100%',
                  marginTop: 10,
                  padding: '10px 12px',
                  borderRadius: 12,
                  border: '1px solid #1f1f1f',
                  background: ARENA_GRADIENT,
                  color: '#fff',
                  fontWeight: 950,
                  cursor: 'pointer',
                }}
                onClick={() => alert('下一关：创建/加入小组')}
              >
                加入/创建小组
              </button>
            </Card>
          </section>
        </div>
      </main>

      {/* 7) 热榜点击后的内容：弹窗显示后续内容/全文骨架 */}
      {hotModalPost ? (
        <Modal onClose={() => setHotModalPost(null)}>
          <div style={{ fontSize: 12, color: ARENA_PURPLE }}>{hotModalPost.group}</div>
          <div style={{ marginTop: 6, fontSize: 20, fontWeight: 950, lineHeight: 1.25 }}>{hotModalPost.title}</div>
          <div style={{ marginTop: 8, fontSize: 12, color: '#777' }}>
            {hotModalPost.author} · {hotModalPost.time} · 💬 {hotModalPost.comments}
          </div>
          <div style={{ marginTop: 12, fontSize: 14, color: '#d6d6d6', lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>
            {hotModalPost.body}
          </div>

          <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid #141414', display: 'flex', gap: 14, flexWrap: 'wrap' }}>
            <Action text="👍 赞同" onClick={() => alert('下一关：热榜详情赞同')} />
            <Action text="👎 反对" onClick={() => alert('下一关：热榜详情反对')} />
            <Action text="💬 评论" onClick={() => alert('下一关：热榜详情评论')} />
            <Action text="🔁 转发" onClick={() => alert('下一关：热榜详情转发')} />
            <div style={{ flex: 1 }} />
            <Action text="🔖 收藏" onClick={() => alert('下一关：热榜详情收藏夹')} />
            <Action text="🎁 礼物" onClick={() => alert('下一关：热榜详情礼物/打赏')} />
          </div>
        </Modal>
      ) : null}
    </div>
  )
}

/* ---------- components ---------- */

function NavBtn(props: { active: boolean; children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      onClick={props.onClick}
      style={{
        border: 'none',
        background: 'transparent',
        color: props.active ? '#eaeaea' : '#cfcfcf',
        cursor: 'pointer',
        fontSize: 13,
        fontWeight: props.active ? 950 : 700,
        padding: '6px 8px',
        borderRadius: 10,
      }}
    >
      {props.children}
    </button>
  )
}

function Card(props: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ border: '1px solid #1f1f1f', borderRadius: 16, background: '#0b0b0b', padding: 14 }}>
      <div style={{ fontWeight: 950, marginBottom: 10 }}>{props.title}</div>
      {props.children}
    </div>
  )
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

function VoteBtn(props: { active: boolean; children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      onClick={props.onClick}
      style={{
        padding: '8px 10px',
        border: 'none',
        borderRight: '1px solid #1f1f1f',
        background: props.active ? '#111111' : '#0c0c0c',
        color: props.active ? '#eaeaea' : '#bdbdbd',
        fontSize: 12,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        fontWeight: 950,
      }}
    >
      {props.children}
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

const pillLink: React.CSSProperties = {
  display: 'block',
  padding: '10px 12px',
  marginBottom: 10,
  borderRadius: 12,
  border: '1px solid #1f1f1f',
  textDecoration: 'none',
  color: '#eaeaea',
  fontSize: 13,
}
