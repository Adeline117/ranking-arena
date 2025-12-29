'use client'

import { useEffect, useMemo, useState } from 'react'

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
  pollEnabled?: boolean
  poll?: { bull: number; bear: number; wait: number }
  hotScore?: number
}

const ARENA_PURPLE = '#a855f7'

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

export default function PostFeed() {
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

  const [expanded, setExpanded] = useState<Record<number, boolean>>({})
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

  const toggleExpand = (postId: number) => setExpanded((p) => ({ ...p, [postId]: !p[postId] }))
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
    <div>
      {posts.map((p) => {
        const isOpen = !!expanded[p.id]
        const showPoll = !!p.pollEnabled
        const poll = pollState[p.id]
        const winner = showPoll && poll ? getPollWinner(poll) : 'tie'
        const label = pollLabel(winner)
        const color = pollColor(winner)

        const reacts = reactCounts[p.id] ?? { up: p.likes, down: Math.floor(p.likes * 0.08) }
        const mine = myReact[p.id]

        const previewLen = 72
        const preview = p.body.length > previewLen ? p.body.slice(0, previewLen) + '…' : p.body

        return (
          <div key={p.id} style={{ padding: '10px 0', borderBottom: '1px solid #141414' }}>
            <div style={{ fontSize: 12, color: ARENA_PURPLE }}>{p.group}</div>

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
                title={showPoll ? '基于投票结果' : '该帖未开启投票，默认观望'}
              >
                {label}
              </span>
            </div>

            <div style={{ marginTop: 8, fontSize: 12, color: '#cfcfcf', lineHeight: 1.5 }}>
              {isOpen ? p.body : preview}
            </div>

            <div style={{ marginTop: 8, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <MiniBtn active={mine === 'up'} onClick={() => toggleReact(p.id, 'up')}>
                👍 {reacts.up}
              </MiniBtn>
              <MiniBtn active={mine === 'down'} onClick={() => toggleReact(p.id, 'down')}>
                👎 {reacts.down}
              </MiniBtn>

              <MiniBtn onClick={() => toggleComments(p.id)}>💬 评论 {p.comments}</MiniBtn>
              <MiniBtn onClick={() => toggleExpand(p.id)}>{isOpen ? '收起' : '展开'}</MiniBtn>

              {isOpen && showPoll && poll ? (
                <>
                  <MiniBtn active={myVote[p.id] === 'bull'} onClick={() => toggleVote(p.id, 'bull')}>
                    看多 {poll.bull}
                  </MiniBtn>
                  <MiniBtn active={myVote[p.id] === 'bear'} onClick={() => toggleVote(p.id, 'bear')}>
                    看空 {poll.bear}
                  </MiniBtn>
                  <MiniBtn active={myVote[p.id] === 'wait'} onClick={() => toggleVote(p.id, 'wait')}>
                    观望 {poll.wait}
                  </MiniBtn>
                </>
              ) : null}
            </div>

            {commentsOpen[p.id] ? (
              <div style={{ marginTop: 10, borderTop: '1px solid #141414', paddingTop: 10 }}>
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
                      background: 'linear-gradient(135deg,#7c3aed,#a855f7)',
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

            <div style={{ marginTop: 8, fontSize: 12, color: '#777' }}>
              {p.author} · {p.time}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function MiniBtn(props: { children: React.ReactNode; onClick: () => void; active?: boolean }) {
  return (
    <button
      onClick={props.onClick}
      style={{
        border: '1px solid #1f1f1f',
        background: props.active ? '#111111' : '#0c0c0c',
        color: props.active ? '#eaeaea' : '#bdbdbd',
        borderRadius: 999,
        padding: '6px 10px',
        fontSize: 12,
        cursor: 'pointer',
        fontWeight: 900,
      }}
    >
      {props.children}
    </button>
  )
}
