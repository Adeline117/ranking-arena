/**
 * OG image for Trading Personality Quiz results
 * GET /api/og/quiz?type=sniper&match=87&lang=en
 *
 * Renders a 1200x630 social card for sharing quiz results.
 * Edge runtime, no DB calls, highly cacheable.
 */

import { ImageResponse } from 'next/og'
import { NextRequest } from 'next/server'

export const runtime = 'edge'

// Type definitions (inline to avoid importing client-side modules in edge)
const TYPES: Record<string, { name: string; nameZh: string; color: string; gradient: string; master: string; masterZh: string; tagline: string; taglineZh: string }> = {
  sniper: { name: 'The Sniper', nameZh: '精准狙击手', color: '#3B82F6', gradient: 'linear-gradient(135deg, #3B82F6 0%, #6366F1 100%)', master: 'Jesse Livermore', masterZh: 'Jesse Livermore', tagline: 'Patient precision, perfect timing', taglineZh: '耐心等待，精准出击' },
  scalper: { name: 'The Scalper', nameZh: '闪电侠', color: '#F59E0B', gradient: 'linear-gradient(135deg, #F59E0B 0%, #F97316 100%)', master: 'Paul Rotter', masterZh: 'Paul Rotter', tagline: 'Speed is the ultimate edge', taglineZh: '速度就是最大的优势' },
  whale: { name: 'The Whale', nameZh: '巨鲸', color: '#06B6D4', gradient: 'linear-gradient(135deg, #06B6D4 0%, #0891B2 100%)', master: 'George Soros', masterZh: 'George Soros', tagline: 'Big conviction, big positions', taglineZh: '强信念，大仓位' },
  analyst: { name: 'The Analyst', nameZh: '数据科学家', color: '#8B5CF6', gradient: 'linear-gradient(135deg, #8B5CF6 0%, #7C3AED 100%)', master: 'Jim Simons', masterZh: 'Jim Simons', tagline: 'Data reveals what intuition hides', taglineZh: '数��揭示直觉隐藏的真相' },
  contrarian: { name: 'The Contrarian', nameZh: '逆行者', color: '#EF4444', gradient: 'linear-gradient(135deg, #EF4444 0%, #DC2626 100%)', master: 'Michael Burry', masterZh: 'Michael Burry', tagline: 'Be fearful when others are greedy', taglineZh: '别人贪婪时恐惧' },
  hodler: { name: 'The HODLer', nameZh: '钻石手', color: '#10B981', gradient: 'linear-gradient(135deg, #10B981 0%, #059669 100%)', master: 'Warren Buffett', masterZh: 'Warren Buffett', tagline: 'Time in the market beats timing', taglineZh: '持有时间胜过择时' },
  degen: { name: 'The Degen', nameZh: '赌神', color: '#F97316', gradient: 'linear-gradient(135deg, #F97316 0%, #EF4444 100%)', master: 'Richard Dennis', masterZh: 'Richard Dennis', tagline: 'Fortune favors the bold', taglineZh: '财富青睐勇敢者' },
  strategist: { name: 'The Strategist', nameZh: '棋手', color: '#6366F1', gradient: 'linear-gradient(135deg, #6366F1 0%, #4F46E5 100%)', master: 'Ray Dalio', masterZh: 'Ray Dalio', tagline: 'Diversify, balance, endure', taglineZh: '分散、平衡、持久' },
}

const C = {
  bgTop: '#0A0A0F',
  bgBottom: '#1A1A2E',
  white: '#FFFFFF',
  offWhite: '#EDEDED',
  dim: 'rgba(255,255,255,0.50)',
  dimmer: 'rgba(255,255,255,0.28)',
  gold: '#D4AF37',
  goldDim: 'rgba(212,175,55,0.15)',
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const typeId = searchParams.get('type') || 'sniper'
  const match = parseInt(searchParams.get('match') || '85', 10)
  const lang = searchParams.get('lang') || 'en'

  const t = TYPES[typeId] || TYPES.sniper
  const isZh = lang === 'zh'
  const typeName = isZh ? t.nameZh : t.name
  const masterName = isZh ? t.masterZh : t.master
  const tagline = isZh ? t.taglineZh : t.tagline
  const matchClamped = Math.min(99, Math.max(60, match))

  return new ImageResponse(
    (
      <div
        style={{
          width: 1200,
          height: 630,
          display: 'flex',
          flexDirection: 'column',
          background: `linear-gradient(180deg, ${C.bgTop} 0%, ${C.bgBottom} 100%)`,
          fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        {/* Background blobs */}
        <div
          style={{
            position: 'absolute',
            top: -120,
            left: -80,
            width: 480,
            height: 480,
            background: `radial-gradient(circle, ${t.color}25 0%, transparent 70%)`,
            display: 'flex',
          }}
        />
        <div
          style={{
            position: 'absolute',
            bottom: -100,
            right: -60,
            width: 400,
            height: 400,
            background: `radial-gradient(circle, ${C.goldDim} 0%, transparent 70%)`,
            display: 'flex',
          }}
        />

        {/* Top accent bar */}
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            height: 4,
            background: t.gradient,
            display: 'flex',
          }}
        />

        {/* Main content */}
        <div
          style={{
            position: 'relative',
            display: 'flex',
            flexDirection: 'column',
            height: '100%',
            padding: '40px 56px 36px',
            zIndex: 1,
          }}
        >
          {/* Top row: Logo + badge */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ width: 8, height: 8, borderRadius: 999, background: C.gold, display: 'flex' }} />
              <span style={{ fontSize: 16, fontWeight: 800, color: C.gold, letterSpacing: '1.5px' }}>ARENA</span>
              <span style={{ fontSize: 13, color: C.dimmer, marginLeft: 4 }}>arenafi.org</span>
            </div>
            <div
              style={{
                display: 'flex',
                padding: '6px 16px',
                borderRadius: 8,
                background: 'rgba(255,255,255,0.06)',
                border: '1px solid rgba(255,255,255,0.12)',
              }}
            >
              <span style={{ fontSize: 14, fontWeight: 700, color: C.dim, letterSpacing: '1px' }}>
                TRADING PERSONALITY
              </span>
            </div>
          </div>

          {/* Center: Type name */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 24 }}>
            <div
              style={{
                fontSize: 52,
                fontWeight: 900,
                color: t.color,
                letterSpacing: '-1px',
                display: 'flex',
              }}
            >
              {typeName}
            </div>
          </div>

          {/* Match bar */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 28 }}>
            <div
              style={{
                flex: 1,
                maxWidth: 400,
                height: 12,
                borderRadius: 6,
                background: 'rgba(255,255,255,0.08)',
                overflow: 'hidden',
                display: 'flex',
              }}
            >
              <div
                style={{
                  width: `${matchClamped}%`,
                  height: '100%',
                  borderRadius: 6,
                  background: t.gradient,
                  display: 'flex',
                }}
              />
            </div>
            <span style={{ fontSize: 28, fontWeight: 900, color: t.color }}>{matchClamped}%</span>
          </div>

          {/* Master info */}
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              padding: '20px 24px',
              borderRadius: 16,
              background: `${t.color}12`,
              border: `1px solid ${t.color}25`,
              flex: 1,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: C.dimmer, letterSpacing: '2px' }}>
                {isZh ? '传奇大师' : 'LEGENDARY MATCH'}
              </span>
            </div>
            <span style={{ fontSize: 32, fontWeight: 900, color: C.white, display: 'flex' }}>
              {masterName}
            </span>
            <span style={{ fontSize: 18, color: C.dim, fontStyle: 'italic', display: 'flex' }}>
              &ldquo;{tagline}&rdquo;
            </span>
          </div>

          {/* Bottom CTA */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginTop: 20,
              paddingTop: 16,
              borderTop: '1px solid rgba(255,255,255,0.06)',
            }}
          >
            <span style={{ fontSize: 15, fontWeight: 600, color: C.dim }}>
              {isZh ? '测测你的交易人格' : 'Discover your trading personality'}
            </span>
            <span style={{ fontSize: 15, fontWeight: 700, color: t.color }}>
              arenafi.org/quiz
            </span>
          </div>
        </div>
      </div>
    ),
    {
      width: 1200,
      height: 630,
      headers: {
        'Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=604800',
      },
    }
  )
}
