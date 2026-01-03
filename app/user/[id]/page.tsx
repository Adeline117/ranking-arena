'use client'

import Link from 'next/link'
import { use, useEffect, useMemo, useState } from 'react'
import { supabase } from '@/lib/supabase/client'
import TopNav from '@/app/components/Layout/TopNav'
import { useLanguage } from '@/app/components/Utils/LanguageProvider'

type UserProfile = {
  id: string
  handle: string | null
  bio: string | null
  avatar_url: string | null
}

type Group = {
  id: string
  name: string
  subtitle?: string | null
}

type Post = {
  id: string
  group_id: string | null
  title: string
  content: string | null
  created_at: string
  author_id?: string | null
  author_handle?: string | null
}

type TabKey = 'overview' | 'stats' | 'portfolio' | 'chart'

/* ---------- tiny helpers ---------- */
function hashSeed(str: string) {
  let h = 2166136261
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}
function mulberry32(a: number) {
  return function () {
    let t = (a += 0x6d2b79f5)
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
function fmtPct(x: number) {
  const sign = x > 0 ? '+' : ''
  return `${sign}${x.toFixed(2)}%`
}
function compact(n: number) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
  return String(n)
}

const panel: React.CSSProperties = {
  background: 'rgba(255,255,255,0.03)',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 16,
  padding: 16,
}

const btnPrimary: React.CSSProperties = {
  border: 'none',
  background: '#2fe57d',
  color: '#04120a',
  fontWeight: 900,
  padding: '10px 14px',
  borderRadius: 12,
  cursor: 'pointer',
}

const btnGhost: React.CSSProperties = {
  border: '1px solid rgba(255,255,255,0.14)',
  background: 'rgba(255,255,255,0.05)',
  color: 'rgba(255,255,255,0.86)',
  fontWeight: 900,
  padding: '10px 14px',
  borderRadius: 12,
  cursor: 'pointer',
}

const select: React.CSSProperties = {
  background: 'rgba(255,255,255,0.05)',
  color: 'rgba(255,255,255,0.85)',
  border: '1px solid rgba(255,255,255,0.14)',
  borderRadius: 12,
  padding: '8px 10px',
  outline: 'none',
  fontWeight: 900,
  fontSize: 12,
}

function BarChart({ bars, height }: { bars: number[]; height: number }) {
  const max = Math.max(...bars.map((x) => Math.abs(x)), 1)
  return (
    <div style={{ height, display: 'flex', alignItems: 'flex-end', gap: 10 }}>
      {bars.map((v, i) => {
        const h = Math.round((Math.abs(v) / max) * (height - 20))
        const isPos = v >= 0
        return (
          <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
            <div
              style={{
                height: h,
                borderRadius: 10,
                background: isPos ? 'rgba(47,229,125,0.55)' : 'rgba(255,77,77,0.55)',
                border: '1px solid rgba(255,255,255,0.08)',
              }}
              title={v.toFixed(2) + '%'}
            />
          </div>
        )
      })}
    </div>
  )
}

function Tab({ active, children, onClick }: { active: boolean; children: any; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        border: 'none',
        background: 'transparent',
        color: active ? '#ffffff' : 'rgba(255,255,255,0.6)',
        fontWeight: active ? 900 : 800,
        fontSize: 13,
        padding: '8px 10px',
        borderBottom: active ? '2px solid rgba(47,229,125,0.9)' : '2px solid transparent',
        cursor: 'pointer',
      }}
    >
      {children}
    </button>
  )
}

function MiniKpi({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        padding: 12,
        borderRadius: 14,
        background: 'rgba(255,255,255,0.04)',
        border: '1px solid rgba(255,255,255,0.06)',
      }}
    >
      <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.55)', fontWeight: 800 }}>{label}</div>
      <div style={{ marginTop: 6, fontSize: 18, fontWeight: 900 }}>{value}</div>
    </div>
  )
}

/* =====================
   Page
===================== */

export default function UserPage(props: { params: any }) {
  const resolvedParams =
    props.params && typeof props.params.then === 'function' ? use(props.params) : props.params

  const routeId = String(resolvedParams?.id ?? '')
  const { t } = useLanguage()

  /* auth */
  const [email, setEmail] = useState<string | null>(null)
  const [currentUserId, setCurrentUserId] = useState<string | null>(null)
  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setEmail(data.user?.email ?? null)
      setCurrentUserId(data.user?.id ?? null)
    })
  }, [])

  /* data */
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [groups, setGroups] = useState<Group[]>([])
  const [posts, setPosts] = useState<Post[]>([])
  const [loading, setLoading] = useState(true)

  /* UI state */
  const [tab, setTab] = useState<TabKey>('overview')
  const [perfRange, setPerfRange] = useState<'90D' | '7D' | '30D' | 'Years'>('Years')

  const seed = useMemo(() => hashSeed(routeId), [routeId])

  // 固定随机（不要在 render 里 rng()）
  const mockNumbers = useMemo(() => {
    const r = mulberry32(seed ^ 0x13579bdf)
    return {
      following: Math.floor(20 + r() * 500),
      followers: Math.floor(100 + r() * 50000),
      ytd: (r() - 0.35) * 120,
      oneY: (r() - 0.25) * 220,
      maxDD: -5 - r() * 35,
      win: 35 + r() * 45,
      totalTrades: Math.floor(80 + r() * 420),
      avgRisk: 3 + Math.floor(r() * 5),
      weeklyMaxDD: -5 - r() * 20,
      profitableWeeks: 35 + r() * 30,
    }
  }, [seed])

  // 一年 12 个月 performance（mock，可换真实表）
  const monthly = useMemo(() => {
    const r = mulberry32(seed)
    return Array.from({ length: 12 }).map(() => (r() - 0.45) * 25)
  }, [seed])

  // 90D/7D/30D/Years performance 预览（mock）
  const perfPreview = useMemo(() => {
    const n = perfRange === '7D' ? 7 : perfRange === '30D' ? 10 : perfRange === 'Years' ? 7 : 9
    const r = mulberry32(seed ^ 0x9e3779b9)
    return Array.from({ length: n }).map((_, i) => (r() - 0.45) * 12 + (i - n / 2) * (r() - 0.5) * 0.4)
  }, [perfRange, seed])

  useEffect(() => {
    const load = async () => {
      setLoading(true)

      // ✅ routeId 就是 uuid，直接按 id 查
      const { data: resolved } = await supabase
        .from('user_profiles')
        .select('id, handle, bio, avatar_url')
        .eq('id', routeId)
        .maybeSingle()

      setProfile((resolved as any) ?? null)

      // ✅ 后续统一用 userUuid 作为 uuid
      const userUuid = (resolved as any)?.id ?? routeId
      const userHandle = (resolved as any)?.handle ?? null

      // groups joined（按 uuid）
      if (userUuid) {
        const { data: memberRows } = await supabase
          .from('group_members')
          .select('group_id')
          .eq('user_id', userUuid)
          .limit(50)

        const groupIds = (memberRows ?? []).map((x: any) => x.group_id).filter(Boolean)

        if (groupIds.length > 0) {
          const { data: gData } = await supabase
            .from('groups')
            .select('id, name, subtitle')
            .in('id', groupIds)
            .limit(50)

          setGroups((gData ?? []) as Group[])
        } else {
          setGroups([])
        }
      } else {
        setGroups([])
      }

      // posts（先按 author_id(uuid) 查，再按 author_handle 查）
      const collected: Post[] = []

      if (userUuid) {
        const { data: postsById } = await supabase
          .from('posts')
          .select('id, group_id, title, content, created_at, author_id, author_handle')
          .eq('author_id', userUuid)
          .order('created_at', { ascending: false })
          .limit(20)

        if (postsById?.length) collected.push(...(postsById as any))
      }

      if (userHandle) {
        const { data: postsByHandle } = await supabase
          .from('posts')
          .select('id, group_id, title, content, created_at, author_id, author_handle')
          .eq('author_handle', userHandle)
          .order('created_at', { ascending: false })
          .limit(20)

        if (postsByHandle?.length) collected.push(...(postsByHandle as any))
      }

      const uniq = Array.from(new Map(collected.map((x) => [x.id, x])).values())
        .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
        .slice(0, 20)

      setPosts(uniq)
      setLoading(false)
    }

    load()
  }, [routeId])

  const isOwnProfile = currentUserId === routeId

  return (
    <div style={{ minHeight: '100vh', background: '#060606', color: '#f2f2f2' }}>
      <TopNav email={email} />

      <main style={{ maxWidth: 1200, margin: '0 auto', padding: '18px 16px' }}>
        <div style={{ marginBottom: 10, fontSize: 12, color: 'rgba(255,255,255,0.6)' }}>
          <Link href="/" style={{ color: 'rgba(255,255,255,0.7)' }}>
            ← 返回
          </Link>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 360px', gap: 16 }}>
          {/* ===== 左：主内容 ===== */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {/* 顶部用户信息卡 */}
            <div style={panel}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                  <Link href={`/user/${routeId}`}>
                    <div
                      style={{
                        width: 64,
                        height: 64,
                        borderRadius: 16,
                        background: 'rgba(255,255,255,0.10)',
                        border: '1px solid rgba(255,255,255,0.10)',
                        overflow: 'hidden',
                        display: 'grid',
                        placeItems: 'center',
                        fontWeight: 900,
                        fontSize: 20,
                        cursor: 'pointer',
                      }}
                      title="avatar"
                    >
                      {profile?.avatar_url ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={profile.avatar_url} alt="avatar" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                      ) : (
                        (profile?.handle?.[0] || routeId?.[0] || 'U').toUpperCase()
                      )}
                    </div>
                  </Link>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <div style={{ fontSize: 20, fontWeight: 900 }}>{profile?.handle || routeId}</div>
                      <div
                        style={{
                          fontSize: 12,
                          padding: '2px 8px',
                          borderRadius: 999,
                          background: 'rgba(255,255,255,0.08)',
                          color: 'rgba(255,255,255,0.78)',
                          fontWeight: 800,
                        }}
                      >
                        @{routeId.slice(0, 8)}
                      </div>
                    </div>

                    <div style={{ display: 'flex', gap: 14, marginTop: 4 }}>
                      <span style={{ color: 'rgba(255,255,255,0.7)', fontSize: 12 }}>
                        {t('following')} <b style={{ color: '#fff' }}>{mockNumbers.following}</b>
                      </span>
                      <span style={{ color: 'rgba(255,255,255,0.7)', fontSize: 12 }}>
                        {t('followers')} <b style={{ color: '#fff' }}>{compact(mockNumbers.followers)}</b>
                      </span>
                    </div>

                    <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.7)', lineHeight: 1.5, marginTop: 4 }}>
                      {profile?.bio || t('bio') + '：这个用户还没有写个人简介。'}
                    </div>
                  </div>
                </div>

                {!isOwnProfile && (
                  <div style={{ display: 'flex', gap: 10 }}>
                    <button style={btnGhost} onClick={() => alert('Follow (mock)')}>{t('follow')}</button>
                  </div>
                )}
              </div>
            </div>

            {/* Performance */}
            <div style={panel}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ fontSize: 14, fontWeight: 900 }}>{t('performance')}</div>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                  <select value={perfRange} onChange={(e) => setPerfRange(e.target.value as any)} style={select}>
                    <option value="Years">Years</option>
                    <option value="90D">90D</option>
                    <option value="30D">30D</option>
                    <option value="7D">7D</option>
                  </select>

                  <button
                    style={{ ...btnGhost, padding: '8px 12px' }}
                    onClick={() => {
                      setTab('stats')
                      const el = document.getElementById('detail-tabs')
                      el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                    }}
                  >
                    {t('details')} →
                  </button>
                </div>
              </div>

              <div style={{ marginTop: 14 }}>
                <BarChart bars={perfRange === 'Years' ? monthly : perfPreview} height={180} />
              </div>

              <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
                <MiniKpi label="YTD" value={fmtPct(mockNumbers.ytd)} />
                <MiniKpi label="1Y" value={fmtPct(mockNumbers.oneY)} />
                <MiniKpi label="Max DD" value={`${mockNumbers.maxDD.toFixed(2)}%`} />
                <MiniKpi label="Win rate" value={`${mockNumbers.win.toFixed(2)}%`} />
              </div>
            </div>

            {/* 动态 */}
            <div style={panel}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ fontSize: 14, fontWeight: 900 }}>{t('activities')} / {t('groups')}发帖</div>
                <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)' }}>
                  {loading ? t('loading') : `${posts.length} posts`}
                </div>
              </div>

              <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
                {!loading && posts.length === 0 ? (
                  <div style={{ color: 'rgba(255,255,255,0.6)', fontSize: 13 }}>暂无动态。</div>
                ) : (
                  posts.map((p) => (
                    <div
                      key={p.id}
                      style={{
                        padding: 12,
                        borderRadius: 12,
                        background: 'rgba(255,255,255,0.04)',
                        border: '1px solid rgba(255,255,255,0.06)',
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                        <div style={{ fontWeight: 900 }}>{p.title}</div>
                        {p.group_id ? (
                          <Link href={`/groups/${p.group_id}`} style={{ fontSize: 12, color: 'rgba(255,255,255,0.6)' }}>
                            去小组 →
                          </Link>
                        ) : null}
                      </div>

                      {p.content ? (
                        <div style={{ marginTop: 8, fontSize: 13, color: 'rgba(255,255,255,0.75)', lineHeight: 1.5 }}>
                          {p.content}
                        </div>
                      ) : null}

                      <div style={{ marginTop: 8, fontSize: 12, color: 'rgba(255,255,255,0.5)' }}>
                        {new Date(p.created_at).toLocaleString()}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* 详情 Tabs */}
            <div id="detail-tabs" style={panel}>
              <div style={{ display: 'flex', gap: 18, alignItems: 'center', borderBottom: '1px solid rgba(255,255,255,0.08)', paddingBottom: 10 }}>
                <Tab active={tab === 'overview'} onClick={() => setTab('overview')}>Overview</Tab>
                <Tab active={tab === 'stats'} onClick={() => setTab('stats')}>{t('stats')}</Tab>
                <Tab active={tab === 'portfolio'} onClick={() => setTab('portfolio')}>{t('portfolio')}</Tab>
                <Tab active={tab === 'chart'} onClick={() => setTab('chart')}>{t('chart')}</Tab>
              </div>

              <div style={{ marginTop: 14 }}>
                {tab === 'overview' && (
                  <div style={{ color: 'rgba(255,255,255,0.75)', fontSize: 13, lineHeight: 1.6 }}>
                    Overview 骨架（后面接真实数据：偏好/风格/常交易标的）。
                  </div>
                )}

                {tab === 'stats' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    <div style={{ fontWeight: 900 }}>Performance (Monthly)</div>
                    <BarChart bars={monthly} height={170} />
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
                      <MiniKpi label="Total Trades (12M)" value={String(mockNumbers.totalTrades)} />
                      <MiniKpi label="Avg. Risk (7D)" value={String(mockNumbers.avgRisk)} />
                      <MiniKpi label="Weekly Max DD" value={`${mockNumbers.weeklyMaxDD.toFixed(2)}%`} />
                      <MiniKpi label="Profitable weeks" value={`${mockNumbers.profitableWeeks.toFixed(2)}%`} />
                    </div>
                  </div>
                )}

                {tab === 'portfolio' && (
                  <div>
                    <div style={{ fontWeight: 900, marginBottom: 10 }}>{t('portfolio')}</div>
                    <div style={{ color: 'rgba(255,255,255,0.6)', fontSize: 13 }}>
                      这里你后面接 user_portfolio 表；样式抄 Trader Portfolio（不要 Buy）。
                    </div>
                  </div>
                )}

                {tab === 'chart' && (
                  <div>
                    <div style={{ fontWeight: 900, marginBottom: 10 }}>{t('chart')} (TradingView style)</div>
                    <div
                      style={{
                        height: 360,
                        borderRadius: 16,
                        border: '1px solid rgba(255,255,255,0.08)',
                        background:
                          'radial-gradient(1200px 500px at 30% 10%, rgba(255,255,255,0.06), transparent 55%), linear-gradient(180deg, rgba(255,255,255,0.03), rgba(0,0,0,0))',
                        position: 'relative',
                        overflow: 'hidden',
                      }}
                    >
                      <div
                        style={{
                          position: 'absolute',
                          inset: 0,
                          opacity: 0.16,
                          backgroundImage:
                            'linear-gradient(rgba(255,255,255,0.12) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.12) 1px, transparent 1px)',
                          backgroundSize: '60px 60px',
                        }}
                      />
                      <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: 'rgba(255,255,255,0.45)' }}>
                        <div style={{ textAlign: 'center' }}>
                          <div style={{ fontSize: 44, marginBottom: 10 }}>📊</div>
                          <div>No data here</div>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* ===== 右：侧边栏 ===== */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {/* 徽章卡 */}
            <div style={panel}>
              <div style={{ fontSize: 14, fontWeight: 900 }}>{t('badges')}</div>

              <div style={{ marginTop: 12, display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                {['OG', 'Alpha', 'Builder', 'Risk-6'].map((b) => (
                  <span
                    key={b}
                    style={{
                      padding: '6px 10px',
                      borderRadius: 999,
                      border: '1px solid rgba(255,255,255,0.14)',
                      background: 'rgba(255,255,255,0.05)',
                      fontWeight: 900,
                      fontSize: 12,
                      color: 'rgba(255,255,255,0.85)',
                    }}
                    title="badge"
                  >
                    {b}
                  </span>
                ))}
              </div>

              {isOwnProfile && (
                <Link
                  href="/settings"
                  style={{
                    ...btnGhost,
                    marginTop: 12,
                    width: '100%',
                    display: 'block',
                    textAlign: 'center',
                    textDecoration: 'none',
                  }}
                >
                  {t('editProfile')}
                </Link>
              )}
            </div>

            {/* 已加入小组 */}
            <div style={panel}>
              <div style={{ fontSize: 14, fontWeight: 900 }}>{t('joinGroup')}</div>

              <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
                {loading ? (
                  <div style={{ color: 'rgba(255,255,255,0.6)', fontSize: 13 }}>{t('loading')}</div>
                ) : groups.length === 0 ? (
                  <div style={{ color: 'rgba(255,255,255,0.6)', fontSize: 13 }}>还没有加入任何小组。</div>
                ) : (
                  groups.map((g) => (
                    <Link
                      key={g.id}
                      href={`/groups/${g.id}`}
                      style={{
                        textDecoration: 'none',
                        padding: 12,
                        borderRadius: 12,
                        background: 'rgba(255,255,255,0.04)',
                        border: '1px solid rgba(255,255,255,0.06)',
                        color: '#fff',
                        transition: 'all 200ms ease',
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.background = 'rgba(255,255,255,0.08)'
                        e.currentTarget.style.borderColor = 'rgba(255,255,255,0.12)'
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = 'rgba(255,255,255,0.04)'
                        e.currentTarget.style.borderColor = 'rgba(255,255,255,0.06)'
                      }}
                    >
                      <div style={{ fontWeight: 900 }}>{g.name}</div>
                      {g.subtitle ? (
                        <div style={{ marginTop: 6, fontSize: 12, color: 'rgba(255,255,255,0.6)' }}>{g.subtitle}</div>
                      ) : null}
                    </Link>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  )
}
