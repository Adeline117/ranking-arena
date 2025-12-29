'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { supabase } from '../../lib/supabase/client'

const ARENA_GRADIENT = 'linear-gradient(135deg,#7c3aed,#a855f7)'
const ARENA_PURPLE = '#a855f7'

export default function TopNav() {
  const [email, setEmail] = useState<string | null>(null)
  const [searchText, setSearchText] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)

  useEffect(() => {
    const run = async () => {
      const { data } = await supabase.auth.getUser()
      setEmail(data.user?.email ?? null)
    }
    run()
  }, [])

  return (
    <>
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
          {/* Logo */}
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

          {/* ✅ 你要的：首页/小组/热榜 */}
          <nav style={{ display: 'flex', gap: 12, marginLeft: 10, fontSize: 13, color: '#cfcfcf' }}>
            <Link href="/" style={{ color: '#eaeaea', textDecoration: 'none', fontWeight: 900 }}>首页</Link>
            <Link href="/groups" style={{ color: '#cfcfcf', textDecoration: 'none' }}>小组</Link>
            <Link href="/hot" style={{ color: '#cfcfcf', textDecoration: 'none' }}>热榜</Link>
          </nav>

          <div style={{ flex: 1 }} />

          {/* 搜索栏（先保留，不做下拉也行） */}
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
          </div>

          {/* 登录区 */}
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
          </div>
        </div>
      </header>

      {/* 点击外面关闭搜索（先占位） */}
      {searchOpen ? (
        <div onClick={() => setSearchOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 5 }} />
      ) : null}
    </>
  )
}
