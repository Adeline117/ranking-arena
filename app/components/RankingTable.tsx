'use client'

import Link from 'next/link'
import React from 'react'

export type Trader = {
  id: string
  handle: string
  roi: number
  win_rate: number
  followers: number
}

const ARENA_PURPLE = '#a855f7'

export default function RankingTable(props: {
  traders: Trader[]
  loading: boolean
  loggedIn: boolean
}) {
  const { traders, loading, loggedIn } = props

  return (
    <div>
      <div style={{ marginBottom: 10, display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <div style={{ fontWeight: 950, fontSize: 16 }}>赛季排行榜（ROI）</div>
        <div style={{ fontSize: 12, color: '#777' }}>{loggedIn ? '已登录：展示前 50' : '未登录：仅前 10'}</div>
      </div>

      <div style={{ border: '1px solid #1f1f1f', borderRadius: 16, background: '#0b0b0b', padding: 14 }}>
        {loading ? (
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
                <th style={th}>#</th>
                <th style={th}>Trader</th>
                <th style={th}>ROI</th>
                <th style={th}>Win</th>
                <th style={th}>Followers</th>
              </tr>
            </thead>
            <tbody>
              {traders.map((t, idx) => (
                <tr key={t.id}>
                  <td style={td}>{idx + 1}</td>
                  <td style={td}>
                    <Link href={`/trader/${t.id}`} style={{ color: '#eaeaea', textDecoration: 'none', fontWeight: 900 }}>
                      {t.handle}
                    </Link>
                  </td>
                  <td style={td}>
                    <span style={{ color: t.roi >= 0 ? '#7CFFB2' : '#FF7C7C', fontWeight: 950 }}>
                      {Number(t.roi).toFixed(1)}%
                    </span>
                  </td>
                  <td style={td}>{t.win_rate ?? 0}%</td>
                  <td style={td}>{t.followers ?? 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {!loggedIn ? (
          <div style={{ marginTop: 12, fontSize: 12, color: '#777' }}>
            未登录仅展示前 10 名。{' '}
            <Link href="/login" style={{ color: ARENA_PURPLE, textDecoration: 'none', fontWeight: 900 }}>
              登录解锁完整榜单
            </Link>
          </div>
        ) : null}
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
  padding: '10px 6px',
  borderBottom: '1px solid #141414',
  verticalAlign: 'top',
}
