'use client'

import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import { LikeIcon, CommentIcon } from '../Icons'

type PollChoice = 'bull' | 'bear' | 'wait'

type Post = {
  views?: number
  id: number
  group: string
  groupId?: string // 添加小组ID字段
  title: string
  author: string
  authorTraderId?: string
  time: string
  body: string
  comments: number
  likes: number
  pollEnabled?: boolean
  poll?: { bull: number; bear: number; wait: number }
  hotScore?: number
}

const ARENA_PURPLE = '#8b6fa8'

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

function AvatarLink({ handle, traderId }: { handle: string; traderId?: string }) {
  // 统一跳转到 /trader/[handle] 页面
  const href = `/trader/${encodeURIComponent(handle)}`
  return (
    <Link
      href={href}
      onClick={(e) => e.stopPropagation()}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        textDecoration: 'none',
        color: '#eaeaea',
      }}
      title="进入交易者主页"
    >
      <span
        style={{
          width: 24,
          height: 24,
          borderRadius: 8,
          display: 'grid',
          placeItems: 'center',
          background: 'rgba(255,255,255,0.08)',
          border: '1px solid rgba(255,255,255,0.10)',
          fontWeight: 950,
          fontSize: 12,
        }}
      >
        {(handle?.[0] || 'U').toUpperCase()}
      </span>
      <span style={{ fontWeight: 850, fontSize: 12, color: 'rgba(255,255,255,0.78)' }}>{handle}</span>
    </Link>
  )
}

export default function PostFeed(props: { variant?: 'compact' | 'full' } = {}) {
  const variant = props.variant ?? 'compact'

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
        pollEnabled: false,
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

  const [openPost, setOpenPost] = useState<Post | null>(null)

  const [commentsOpen, setCommentsOpen] = useState<Record<number, boolean>>({})
  const [pollState, setPollState] = useState<Record<number, { bull: number; bear: number; wait: number }>>({})
  const [myVote, setMyVote] = useState<Record<number, PollChoice | null>>({})
  const [myReact, setMyReact] = useState<Record<number, 'up' | 'down' | null>>({})
  const [reactCounts, setReactCounts] = useState<Record<number, { up: number; down: number }>>({})

  useEffect(() => {
    setPollState((prev) => {
      const next = { ...prev }
      for (const p of posts) if (p.pollEnabled && p.poll && !next[p.id]) next[p.id] = p.poll
      return next
    })
    setMyVote((prev) => {
      const next = { ...prev }
      for (const p of posts) if (next[p.id] === undefined) next[p.id] = null
      return next
    })
    setMyReact((prev) => {
      const next = { ...prev }
      for (const p of posts) if (next[p.id] === undefined) next[p.id] = null
      return next
    })
    setReactCounts((prev) => {
      const next = { ...prev }
      for (const p of posts) if (!next[p.id]) next[p.id] = { up: p.likes, down: Math.floor(p.likes * 0.08) }
      return next
    })
  }, [posts])

  const toggleComments = (postId: number) => setCommentsOpen((p) => ({ ...p, [postId]: !p[postId] }))

  const toggleVote = (postId: number, choice: PollChoice) => {
    setPollState((prev) => {
      const current = prev[postId]
      if (!current) return prev
      const old = myVote[postId]
      const next = { ...current }

      if (old === choice) next[choice] = Math.max(0, next[choice] - 1)
      else {
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

  const toggleReact = (postId: number, dir: 'up' | 'down') => {
    setReactCounts((prev) => {
      const cur = prev[postId] ?? { up: 0, down: 0 }
      const mine = myReact[postId]
      let next = { ...cur }

      if (mine === dir) next = { ...next, [dir]: Math.max(0, next[dir] - 1) }
      else {
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

  return (
    <>
      <div>
        {posts.map((p) => {
          const reacts = reactCounts[p.id] ?? { up: p.likes, down: Math.floor(p.likes * 0.08) }
          const poll = pollState[p.id]
          const winner = p.pollEnabled && poll ? getPollWinner(poll) : 'tie'
          const label = pollLabel(winner)
          const color = pollColor(winner)

          return (
            <button
              key={p.id}
              onClick={() => setOpenPost(p)}
              style={{
                width: '100%',
                textAlign: 'left',
                border: 'none',
                background: 'transparent',
                padding: '10px 0',
                borderBottom: '1px solid #141414',
                cursor: 'pointer',
                color: '#eaeaea',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                {p.groupId ? (
                  <Link
                    href={`/groups/${p.groupId}`}
                    onClick={(e) => e.stopPropagation()}
                    style={{
                      fontSize: 12,
                      color: ARENA_PURPLE,
                      textDecoration: 'none',
                      cursor: 'pointer',
                    }}
                  >
                    {p.group}
                  </Link>
                ) : (
                  <div
                    style={{
                      fontSize: 12,
                      color: ARENA_PURPLE,
                    }}
                  >
                    {p.group}
                  </div>
                )}
                {/* ✅ 这里就是"点头像进主页" */}
                <AvatarLink handle={p.author} traderId={p.authorTraderId} />
              </div>

              <div style={{ marginTop: 6, fontWeight: 950, lineHeight: 1.25 }}>
                {p.title}{' '}
                <span
                  style={{
                    fontSize: 11,
                    color,
                    fontWeight: 950,
                    border: '1px solid #1f1f1f',
                    padding: '2px 6px',
                    borderRadius: 999,
                    marginLeft: 6,
                  }}
                  title={p.pollEnabled ? '基于投票结果' : '未开启投票，默认观望'}
                >
                  {label}
                </span>
              </div>

              <div style={{ marginTop: 8, display: 'flex', gap: 10, flexWrap: 'wrap', color: '#a9a9a9', fontSize: 12, alignItems: 'center' }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <LikeIcon size={14} /> {reacts.up}
                </span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <LikeIcon size={14} style={{ transform: 'rotate(180deg)' }} /> {reacts.down}
                </span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <CommentIcon size={14} /> {p.comments}
                </span>
              </div>
            </button>
          )
        })}
      </div>

      {openPost ? (
        <Modal onClose={() => setOpenPost(null)}>
          <div style={{ fontSize: 12, color: ARENA_PURPLE }}>{openPost.group}</div>

          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, marginTop: 8 }}>
            <div style={{ fontSize: 20, fontWeight: 950, lineHeight: 1.25 }}>{openPost.title}</div>
            {/* ✅ 弹窗里也能点进主页 */}
            <AvatarLink handle={openPost.author} traderId={openPost.authorTraderId} />
          </div>

          <div style={{ marginTop: 8, fontSize: 12, color: '#777', display: 'flex', alignItems: 'center', gap: 6 }}>
            {openPost.author} · {openPost.time} · <CommentIcon size={12} /> {openPost.comments}
          </div>

          <div style={{ marginTop: 12, fontSize: 14, color: '#d6d6d6', lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>
            {openPost.body}
          </div>

          <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid #141414', display: 'flex', gap: 14, flexWrap: 'wrap' }}>
            <Action icon={<LikeIcon size={14} />} text="赞同" onClick={() => toggleReact(openPost.id, 'up')} active={myReact[openPost.id] === 'up'} />
            <Action icon={<LikeIcon size={14} style={{ transform: 'rotate(180deg)' }} />} text="反对" onClick={() => toggleReact(openPost.id, 'down')} active={myReact[openPost.id] === 'down'} />
            <Action icon={<CommentIcon size={14} />} text="评论" onClick={() => toggleComments(openPost.id)} />
            {openPost.pollEnabled && pollState[openPost.id] ? (
              <>
                <Action text="📈 看多" onClick={() => toggleVote(openPost.id, 'bull')} active={myVote[openPost.id] === 'bull'} />
                <Action text="📉 看空" onClick={() => toggleVote(openPost.id, 'bear')} active={myVote[openPost.id] === 'bear'} />
                <Action text="⏸ 观望" onClick={() => toggleVote(openPost.id, 'wait')} active={myVote[openPost.id] === 'wait'} />
              </>
            ) : null}
          </div>

          {commentsOpen[openPost.id] ? (
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
            </div>
          ) : null}
        </Modal>
      ) : null}
    </>
  )
}

function Action(props: { icon?: React.ReactNode; text: string; onClick: () => void; active?: boolean }) {
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
        display: 'flex',
        alignItems: 'center',
        gap: 4,
      }}
    >
      {props.icon}
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
