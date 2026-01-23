'use client'

import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '../Providers/LanguageProvider'
import { supabase } from '@/lib/supabase/client'
import { useToast } from '@/app/components/ui/Toast'

export type Trader = {
  id: string
  handle: string
  roi: number
  win_rate: number
  followers: number
  bio?: string | null
}

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

export default function TraderDrawer({
  open,
  trader,
  onClose,
}: {
  open: boolean
  trader: Trader | null
  onClose: () => void
}) {
  const { t } = useLanguage()
  const { showToast } = useToast()
  const [tab, setTab] = useState<'overview' | 'stats' | 'portfolio'>(
    'overview'
  )
  const [perfRange, setPerfRange] = useState<'90D' | '7D' | '30D' | 'Years'>('90D')
  const [userId, setUserId] = useState<string | null>(null)
  const [following, setFollowing] = useState(false)
  const [followLoading, setFollowLoading] = useState(false)
  const [lastUpdated, setLastUpdated] = useState<string>('')

  // 获取用户登录状态
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setUserId(data.session?.user?.id ?? null)
    })
  }, [])

  // 检查关注状态
  useEffect(() => {
    if (!userId || !trader?.id) return
    ;(async () => {
      const { data } = await supabase
        .from('trader_follows')
        .select('*')
        .eq('user_id', userId)
        .eq('trader_id', trader.id)
        .maybeSingle()
      setFollowing(!!data)
    })()
  }, [userId, trader?.id])

  // 获取最后更新时间
  useEffect(() => {
    if (!trader?.id) return
    ;(async () => {
      const { data } = await supabase
        .from('trader_snapshots')
        .select('captured_at')
        .eq('source_trader_id', trader.id)
        .order('captured_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (data?.captured_at) {
        setLastUpdated(new Date(data.captured_at).toLocaleString('zh-CN'))
      }
    })()
  }, [trader?.id])

  // 关注/取消关注
  const handleFollow = async () => {
    if (!userId) {
      window.location.href = '/login'
      return
    }
    if (!trader?.id) return

    setFollowLoading(true)
    try {
      if (following) {
        await supabase
          .from('trader_follows')
          .delete()
          .eq('user_id', userId)
          .eq('trader_id', trader.id)
        setFollowing(false)
      } else {
        await supabase
          .from('trader_follows')
          .insert({ user_id: userId, trader_id: trader.id })
        setFollowing(true)
      }
    } catch (err) {
      console.error('Follow error:', err)
      showToast(t('followError') || '操作失败，请重试', 'error')
    } finally {
      setFollowLoading(false)
    }
  }

  // 复制交易（跳转到交易所）
  const handleCopy = () => {
    // 跳转到交易员的交易所页面
    if (trader?.id) {
      window.open(`https://www.binance.com/zh-CN/copy-trading/lead-details/${trader.id}`, '_blank')
    }
  }

  useEffect(() => {
    if (open) {
      setTab('overview')
      setPerfRange('90D')
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const seed = useMemo(() => hashSeed(trader?.id || 'none'), [trader?.id])
  const rng = useMemo(() => mulberry32(seed), [seed])

  const overviewBars = useMemo(() => {
    const n =
      perfRange === '7D' ? 7 : perfRange === '30D' ? 10 : perfRange === 'Years' ? 7 : 9
    return Array.from({ length: n }).map((_, i) => {
      const base = (rng() - 0.45) * 12
      const trend = (i - n / 2) * (rng() - 0.5) * 0.4
      return base + trend
    })
  }, [rng, perfRange])

  const statsMonthly = useMemo(() => {
    return Array.from({ length: 12 }).map(() => (rng() - 0.45) * 25)
  }, [rng])

  const riskMonthly = useMemo(() => {
    return Array.from({ length: 12 }).map(() => {
      const v = 3 + rng() * 6.5
      return Math.max(1, Math.min(10, v))
    })
  }, [rng])

  const frequentlyTraded = useMemo(() => {
    const symbols = ['BTC', 'ETH', 'SOL', 'ARB', 'PEPE', 'LINK', 'AVAX', 'SUI']
    return Array.from({ length: 3 }).map((_, i) => {
      const sym = symbols[(Math.floor(rng() * symbols.length) + i) % symbols.length]
      const weight = 4 + rng() * 12
      const profitable = rng() * 100
      const avgProfit = rng() * 300
      const avgLoss = -(rng() * 70)
      return { sym, weight, profitable, avgProfit, avgLoss }
    })
  }, [rng])

  const portfolioRows = useMemo(() => {
    const markets = ['BTC', 'ETH', 'SOL', 'ARB', 'AVAX', 'LINK', 'SUI', 'OP']
    return Array.from({ length: 10 }).map((_, i) => {
      const m = markets[(Math.floor(rng() * markets.length) + i) % markets.length]
      const dir = rng() > 0.25 ? 'long' : 'short'
      const invested = 2 + rng() * 14
      const pl = (rng() - 0.45) * 180
      const value = invested * (0.6 + rng() * 2.5)
      const price = 1 + rng() * 90000
      return { m, dir, invested, pl, value, price }
    })
  }, [rng])

  if (!open || !trader) return null

  return (
    <>
      {/* backdrop */}
      <div
        onClick={onClose}
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0,0,0,0.55)',
          zIndex: tokens.zIndex.overlay,
        }}
      />

      {/* drawer */}
      <aside
        style={{
          position: 'fixed',
          top: 0,
          right: 0,
          height: '100vh',
          width: 'min(980px, 92vw)',
          background: tokens.colors.bg.primary,
          borderLeft: `1px solid ${tokens.colors.border.primary}`,
          zIndex: tokens.zIndex.modal, // drawer 在 overlay 之上
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* header */}
        <div
          style={{
            padding: '14px 16px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            borderBottom: `1px solid ${tokens.colors.border.primary}`,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div
              style={{
                width: 40,
                height: 40,
                borderRadius: 999,
                background: tokens.colors.bg.secondary,
                display: 'grid',
                placeItems: 'center',
                fontWeight: 900,
              }}
            >
              {trader.handle?.[0]?.toUpperCase() || 'T'}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ fontSize: 18, fontWeight: 900 }}>{trader.handle}</div>
                <span
                  style={{
                    fontSize: 12,
                    padding: '2px 8px',
                    borderRadius: 999,
                    background: tokens.colors.bg.secondary,
                    color: tokens.colors.text.primary,
                    fontWeight: 800,
                  }}
                >
                  Verified
                </span>
              </div>

              <div style={{ fontSize: 12, color: tokens.colors.text.secondary }}>
                ROI {trader.roi.toFixed(1)}% · Win {(trader.win_rate ?? 0).toFixed(1)}% · Followers{' '}
                {compact(trader.followers)}
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Link href={`/trader/${trader.id}`} style={{ ...btnGhost, textDecoration: 'none' }}>
              Open page
            </Link>
            <button 
              style={{
                ...btnGhost,
                background: following ? 'rgba(139, 111, 168, 0.2)' : 'transparent',
                borderColor: following ? '#8b6fa8' : undefined,
              }} 
              onClick={handleFollow}
              disabled={followLoading}
            >
              {followLoading ? '...' : following ? t('following') : t('follow')}
            </button>
            <button style={btnPrimary} onClick={handleCopy}>
              {t('copy')}
            </button>
            <button onClick={onClose} style={iconBtn} aria-label="Close">
              ✕
            </button>
          </div>
        </div>

        {/* tabs */}
        <div
          style={{
            padding: '10px 16px',
            display: 'flex',
            gap: 18,
            alignItems: 'center',
            borderBottom: `1px solid ${tokens.colors.border.primary}`,
          }}
        >
          <Tab active={tab === 'overview'} onClick={() => setTab('overview')}>
            Overview
          </Tab>
          <Tab active={tab === 'stats'} onClick={() => setTab('stats')}>
            Stats
          </Tab>
          <Tab active={tab === 'portfolio'} onClick={() => setTab('portfolio')}>
            Portfolio
          </Tab>
        </div>

        {/* body */}
        <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
          {tab === 'overview' && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 360px', gap: 16 }}>
              {/* left */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                <div style={panel}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ fontSize: 14, fontWeight: 900 }}>Performance</div>
                    <select
                      value={perfRange}
                      onChange={(e) => setPerfRange(e.target.value as any)}
                      style={select}
                    >
                      <option value="90D">90D</option>
                      <option value="7D">7D</option>
                      <option value="30D">30D</option>
                      <option value="Years">Years</option>
                    </select>
                  </div>

                  <div style={{ marginTop: 14 }}>
                    <BarChart bars={overviewBars} height={160} />
                  </div>

                  <div
                    style={{
                      marginTop: 14,
                      display: 'grid',
                      gridTemplateColumns: '1fr 1fr',
                      gap: 12,
                      color: tokens.colors.text.primary,
                      fontSize: 13,
                    }}
                  >
                    <StatRow label="Return (selected)" value={fmtPct(trader.roi)} />
                    <StatRow label="Win rate" value={`${(trader.win_rate ?? 0).toFixed(1)}%`} />
                    <StatRow label="Avg. Risk Score (7D)" value={String(4 + Math.floor(rng() * 4))} />
                    <StatRow label="Profitable weeks" value={`${(35 + rng() * 30).toFixed(2)}%`} />
                  </div>
                </div>

                {/* 动态 + 小组贴（先 mock，后续你可以接 posts/groups） */}
                <div style={panel}>
                  <div style={{ fontSize: 14, fontWeight: 900, marginBottom: 10 }}>Updates</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {Array.from({ length: 3 }).map((_, i) => (
                      <div
                        key={i}
                        style={{
                          padding: 12,
                          borderRadius: 12,
                          background: tokens.colors.bg.secondary,
                          border: `1px solid ${tokens.colors.border.primary}`,
                        }}
                      >
                        <div style={{ fontSize: 13, color: tokens.colors.text.primary }}>
                          {trader.handle} ·{' '}
                          <span style={{ color: tokens.colors.text.secondary }}>{i + 1}d ago</span>
                        </div>
                        <div style={{ marginTop: 8, fontSize: 14, lineHeight: 1.4 }}>
                          {i === 0
                            ? 'Market volatility is high — risk control first.'
                            : i === 1
                            ? 'Watching BTC/ETH levels. No chase. Wait for confirmation.'
                            : 'Breakout setups only. Tight invalidation.'}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* right */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                <div style={panel}>
                  <div style={{ fontSize: 14, fontWeight: 900 }}>About</div>
                  <div style={{ marginTop: 10, fontSize: 13, lineHeight: 1.5, color: tokens.colors.text.primary }}>
                    {trader.bio || '这个 Trader 还没有写个人简介。'}
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 14 }}>
                    <MiniKpi label="Followers" value={compact(trader.followers)} />
                    <MiniKpi label="Copiers" value="—" />
                  </div>
                </div>

                <div style={panel}>
                  <div style={{ fontSize: 14, fontWeight: 900, marginBottom: 10 }}>Similar traders</div>
                  {Array.from({ length: 3 }).map((_, i) => {
                    const h = ['alpha_fox', 'night_whale', 'quant_mantis', 'zero_chill'][i]
                    const r = (rng() - 0.35) * 180
                    return (
                      <div
                        key={h}
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          padding: '10px 12px',
                          borderRadius: 12,
                          background: tokens.colors.bg.secondary,
                          border: `1px solid ${tokens.colors.border.primary}`,
                          marginBottom: 10,
                        }}
                      >
                        <div style={{ fontWeight: 800 }}>{h}</div>
                        <div style={{ color: r >= 0 ? '#2fe57d' : '#ff4d4d', fontWeight: 900 }}>
                          {fmtPct(r)}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            </div>
          )}

          {tab === 'stats' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {/* Performance (monthly like screenshot) */}
              <div style={panel}>
                <div style={{ fontSize: 14, fontWeight: 900 }}>Performance</div>
                <div style={{ marginTop: 14 }}>
                  <BarChart bars={statsMonthly} height={180} />
                </div>

                {/* monthly grid row */}
                <div
                  style={{
                    marginTop: 12,
                    padding: 12,
                    borderRadius: 12,
                    background: 'rgba(255,255,255,0.03)',
                    border: '1px solid rgba(255,255,255,0.06)',
                    display: 'grid',
                    gridTemplateColumns: '60px repeat(12, 1fr)',
                    gap: 8,
                    alignItems: 'center',
                    fontSize: 12,
                    color: tokens.colors.text.secondary,
                  }}
                >
                  <div style={{ color: tokens.colors.text.tertiary }}>2025</div>
                  {statsMonthly.map((m, i) => (
                    <div
                      key={i}
                      style={{
                        textAlign: 'center',
                        padding: '6px 0',
                        borderRadius: 10,
                        background: m >= 0 ? 'rgba(47,229,125,0.12)' : 'rgba(255,77,77,0.12)',
                        color: m >= 0 ? '#2fe57d' : '#ff4d4d',
                        fontWeight: 900,
                      }}
                    >
                      {m.toFixed(2)}%
                    </div>
                  ))}
                </div>

                <div style={{ marginTop: 10, fontSize: 12, color: tokens.colors.text.tertiary }}>
                  Past performance is not indicative of future results.
                </div>
              </div>

              {/* Risk + Compare two columns */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                <div style={panel}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ fontSize: 14, fontWeight: 900 }}>Portfolio Risk (1Y)</div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button style={pillActive}>Risk Score</button>
                      <button style={pill}>Risk Contribution</button>
                    </div>
                  </div>

                  <div style={{ marginTop: 14 }}>
                    <RiskChart scores={riskMonthly} height={160} />
                  </div>

                  <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                    <MiniKpi label="Avg. Risk Score (7D)" value={String(4 + Math.floor(rng() * 4))} />
                    <MiniKpi label="Weekly Max. Drawdown" value={`${(-5 - rng() * 18).toFixed(2)}%`} />
                    <MiniKpi label="Daily Max. Drawdown" value={`${(-2 - rng() * 9).toFixed(2)}%`} />
                    <MiniKpi label="Yearly Max. Drawdown" value={`${(-10 - rng() * 40).toFixed(2)}%`} />
                  </div>
                </div>

                <div style={panel}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ fontSize: 14, fontWeight: 900 }}>Compare portfolio</div>
                    <select style={select}>
                      <option>SPX500</option>
                      <option>BTC</option>
                    </select>
                  </div>

                  <div style={{ marginTop: 14 }}>
                    <CompareChart height={220} />
                  </div>

                  <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <CompareRow name={trader.handle} pct={55.07} />
                    <CompareRow name="SPX500" pct={16.42} />
                  </div>
                </div>
              </div>

              {/* Trading section */}
              <div style={panel}>
                <div style={{ fontSize: 14, fontWeight: 900 }}>Trading</div>

                <div
                  style={{
                    marginTop: 14,
                    display: 'grid',
                    gridTemplateColumns: '1fr 1fr 1fr',
                    gap: 12,
                  }}
                >
                  <MiniKpi label="Total Trades (12M)" value={String(Math.floor(80 + rng() * 420))} />
                  <MiniKpi label="Avg. Profit / Loss" value={`${(50 + rng() * 500).toFixed(2)} / ${(-(20 + rng() * 120)).toFixed(2)}`} />
                  <MiniKpi label="Profitable Trades" value={`${(35 + rng() * 30).toFixed(2)}%`} />
                </div>

                <div style={{ marginTop: 16, fontSize: 14, fontWeight: 900, display: 'flex', justifyContent: 'space-between' }}>
                  <span>Frequently traded</span>
                  <button style={btnGhost}>View all</button>
                </div>

                <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {frequentlyTraded.map((x: any) => (
                    <div
                      key={x.sym}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '140px 1fr 120px',
                        gap: 10,
                        alignItems: 'center',
                        padding: 12,
                        borderRadius: 12,
        background: tokens.colors.bg.secondary,
        border: `1px solid ${tokens.colors.border.primary}`,
                      }}
                    >
                      <div style={{ display: 'flex', flexDirection: 'column' }}>
                        <div style={{ fontWeight: 900 }}>{x.sym}</div>
                        <div style={{ fontSize: 12, color: tokens.colors.text.tertiary }}>
                          {x.weight.toFixed(2)}%
                        </div>
                      </div>

                      <div style={{ fontSize: 12, color: tokens.colors.text.secondary }}>
                        <div>
                          <span style={{ color: tokens.colors.accent.success, fontWeight: 900 }}>
                            {fmtPct(x.avgProfit)}
                          </span>{' '}
                          Avg. Profit
                        </div>
                        <div>
                          <span style={{ color: tokens.colors.accent.error, fontWeight: 900 }}>
                            {fmtPct(x.avgLoss)}
                          </span>{' '}
                          Avg. Loss
                        </div>
                      </div>

                      <div style={{ textAlign: 'right' }}>
                        <div style={{ fontWeight: 900 }}>{x.profitable.toFixed(2)}%</div>
                        <div style={{ fontSize: 12, color: tokens.colors.text.tertiary }}>Profitable</div>
                      </div>
                    </div>
                  ))}
                </div>

                <div style={{ marginTop: 16 }}>
                  <div style={{ fontSize: 14, fontWeight: 900, marginBottom: 10 }}>Additional stats</div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
                    <MiniKpi label="Trades per week" value={(2 + rng() * 10).toFixed(2)} />
                    <MiniKpi label="Avg. holdings time" value={(3 + rng() * 60).toFixed(1) + ' days'} />
                    <MiniKpi label="Tracked since (first seen in Arena)" value="—" />
                    <MiniKpi label="Profitable weeks" value={(35 + rng() * 30).toFixed(2) + '%'} />
                  </div>
                </div>
              </div>
            </div>
          )}

          {tab === 'portfolio' && (
            <div style={panel}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ fontSize: 14, fontWeight: 900 }}>Portfolio</div>
                <div style={{ fontSize: 12, color: tokens.colors.text.tertiary }}>Last updated: {lastUpdated || '—'}</div>
              </div>

              <div style={{ marginTop: 14, borderRadius: 14, overflow: 'hidden', border: '1px solid rgba(255,255,255,0.08)' }}>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '1.2fr 0.8fr 0.9fr 0.9fr 0.9fr 0.9fr',
                    padding: '10px 12px',
                    background: 'rgba(255,255,255,0.04)',
                    fontSize: 12,
                    color: tokens.colors.text.secondary,
                    fontWeight: 900,
                  }}
                >
                  <div>Market</div>
                  <div>Direction</div>
                  <div>Invested</div>
                  <div>P/L(%)</div>
                  <div>Value</div>
                  <div>Price</div>
                </div>

                {portfolioRows.map((r, idx) => (
                  <div
                    key={idx}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '1.2fr 0.8fr 0.9fr 0.9fr 0.9fr 0.9fr',
                      padding: '12px 12px',
                      borderTop: '1px solid rgba(255,255,255,0.06)',
                      alignItems: 'center',
                      background: idx % 2 === 0 ? 'rgba(255,255,255,0.02)' : 'transparent',
                    }}
                  >
                    <div style={{ fontWeight: 900 }}>{r.m}</div>
                    <div style={{ color: tokens.colors.text.primary }}>{r.dir}</div>
                    <div style={{ color: tokens.colors.text.primary }}>{r.invested.toFixed(2)}%</div>
                    <div style={{ color: r.pl >= 0 ? '#2fe57d' : '#ff4d4d', fontWeight: 900 }}>
                      {r.pl.toFixed(2)}%
                    </div>
                    <div style={{ color: tokens.colors.text.primary }}>{r.value.toFixed(2)}%</div>
                    <div style={{ color: tokens.colors.text.primary }}>{r.price.toFixed(2)}</div>
                  </div>
                ))}
              </div>

              <div style={{ marginTop: 10, fontSize: 12, color: 'rgba(255,255,255,0.5)' }}>
                * Portfolio 页按你要求：不显示 Buy 按钮。
              </div>
            </div>
          )}
        </div>
      </aside>
    </>
  )
}

/* -------- small UI helpers -------- */
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
        background: tokens.colors.bg.secondary,
        border: `1px solid ${tokens.colors.border.primary}`,
      }}
    >
      <div style={{ fontSize: 12, color: tokens.colors.text.secondary, fontWeight: 800 }}>{label}</div>
      <div style={{ marginTop: 6, fontSize: 18, fontWeight: 900 }}>{value}</div>
    </div>
  )
}
function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
      <span style={{ color: tokens.colors.text.secondary }}>{label}</span>
      <span style={{ fontWeight: 900 }}>{value}</span>
    </div>
  )
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
function RiskChart({ scores, height }: { scores: number[]; height: number }) {
  const max = 10
  return (
    <div style={{ height, display: 'flex', alignItems: 'flex-end', gap: 10 }}>
      {scores.map((v, i) => {
        const h = Math.round((v / max) * (height - 16))
        const color =
          v >= 7 ? 'rgba(255,165,0,0.75)' : v >= 5 ? 'rgba(255,215,0,0.70)' : 'rgba(255,255,255,0.45)'
        return (
          <div key={i} style={{ flex: 1 }}>
            <div
              style={{
                height: h,
                borderRadius: 10,
                background: color,
                border: '1px solid rgba(255,255,255,0.08)',
              }}
              title={`Risk ${v.toFixed(1)}`}
            />
          </div>
        )
      })}
    </div>
  )
}
function CompareChart({ height }: { height: number }) {
  // 生成随机曲线路径数据
  const _generatePath = (baseY: number, variance: number, isUp: boolean) => {
    const points: string[] = []
    const steps = 10
    let y = baseY
    for (let i = 0; i <= steps; i++) {
      const x = (i / steps) * 600
      const change = (Math.random() - 0.4) * variance
      y = Math.max(40, Math.min(220, y + change + (isUp ? -2 : 0.5)))
      points.push(i === 0 ? `M${x},${y}` : `L${x},${y}`)
    }
    return points.join(' ')
  }

  // 用户ROI曲线（绿色，趋势向上）
  const traderPath = "M0,200 C60,180 120,160 180,140 C240,120 300,100 360,90 C420,80 480,70 540,60 C570,55 600,50 600,45"
  // 比较资产曲线（白色，较平稳）
  const comparePath = "M0,190 C60,185 120,180 180,175 C240,170 300,165 360,160 C420,155 480,150 540,145 C570,142 600,140 600,138"

  return (
    <div
      style={{
        height,
        borderRadius: 14,
        border: '1px solid rgba(255,255,255,0.08)',
        background:
          'radial-gradient(700px 260px at 50% 20%, rgba(255,255,255,0.06), transparent 55%), rgba(255,255,255,0.02)',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          position: 'absolute',
          inset: 0,
          opacity: 0.18,
          backgroundImage:
            'linear-gradient(rgba(255,255,255,0.12) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.12) 1px, transparent 1px)',
          backgroundSize: '70px 70px',
        }}
      />
      <div style={{ position: 'absolute', left: 12, bottom: 12, display: 'flex', gap: 10, color: tokens.colors.text.secondary, fontSize: 12 }}>
        <span>1W</span><span>1M</span><span style={{ color: tokens.colors.text.primary }}>3M</span>
      </div>

      {/* 图例 */}
      <div style={{ position: 'absolute', right: 12, top: 12, display: 'flex', gap: 12, fontSize: 11 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <div style={{ width: 12, height: 3, background: tokens.colors.accent.success, borderRadius: 2 }} />
          <span style={{ color: tokens.colors.text.secondary }}>ROI</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <div style={{ width: 12, height: 3, background: 'rgba(255,255,255,0.5)', borderRadius: 2 }} />
          <span style={{ color: tokens.colors.text.secondary }}>BTC/SPX</span>
        </div>
      </div>

      <svg width="100%" height="100%" viewBox="0 0 600 260" preserveAspectRatio="none" style={{ position: 'absolute', inset: 0 }}>
        {/* 用户ROI曲线 - 绿色 */}
        <path d={traderPath} fill="none" stroke={tokens.colors.accent.success} strokeWidth="2.5" strokeLinecap="round" />
        {/* 比较资产曲线 - 白色半透明 */}
        <path d={comparePath} fill="none" stroke="rgba(255,255,255,0.5)" strokeWidth="2" strokeLinecap="round" strokeDasharray="4,4" />
      </svg>
    </div>
  )
}
function CompareRow({ name, pct }: { name: string; pct: number }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <div style={{ color: tokens.colors.text.primary, fontWeight: 900 }}>{name}</div>
      <div style={{ color: pct >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error, fontWeight: 900 }}>
        {fmtPct(pct)}
      </div>
    </div>
  )
}

/* -------- styles -------- */
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
  color: tokens.colors.text.primary,
  fontWeight: 900,
  padding: '10px 14px',
  borderRadius: 12,
  cursor: 'pointer',
}
const iconBtn: React.CSSProperties = {
  width: 36,
  height: 36,
  borderRadius: 12,
  border: '1px solid rgba(255,255,255,0.14)',
  background: 'rgba(255,255,255,0.05)',
  color: tokens.colors.text.primary,
  cursor: 'pointer',
}
const select: React.CSSProperties = {
  background: 'rgba(255,255,255,0.05)',
  color: tokens.colors.text.primary,
  border: '1px solid rgba(255,255,255,0.14)',
  borderRadius: 12,
  padding: '8px 10px',
  outline: 'none',
  fontWeight: 900,
  fontSize: 12,
}
const pill: React.CSSProperties = {
  border: '1px solid rgba(255,255,255,0.14)',
  background: 'rgba(255,255,255,0.04)',
  color: tokens.colors.text.secondary,
  padding: '8px 10px',
  borderRadius: 999,
  fontWeight: 900,
  fontSize: 12,
}
const pillActive: React.CSSProperties = {
  ...pill,
  background: 'rgba(255,255,255,0.10)',
  color: tokens.colors.text.primary,
}