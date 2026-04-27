/**
 * OG image for Trading Personality Quiz results
 * GET /api/og/quiz?type=sniper&match=87&lang=en
 *
 * Premium social card design — dark cinematic style with type-colored accent.
 * Designed to look stunning when shared on X/Twitter/Telegram.
 * Edge runtime, no DB calls, highly cacheable.
 */

import { ImageResponse } from 'next/og'
import { NextRequest } from 'next/server'
import { checkRateLimit, RateLimitPresets } from '@/lib/api'

export const runtime = 'edge'

const TYPES: Record<
  string,
  {
    name: string
    nameZh: string
    color: string
    colorLight: string
    master: string
    masterZh: string
    tagline: string
    taglineZh: string
    style: string
    styleZh: string
    risk: number
    horizon: string
    horizonZh: string
    icon: string
  }
> = {
  sniper: {
    name: 'THE SNIPER',
    nameZh: '精准狙击手',
    color: '#3B82F6',
    colorLight: '#93C5FD',
    master: 'Jesse Livermore',
    masterZh: 'Jesse Livermore',
    tagline: 'Patient precision, perfect timing',
    taglineZh: '耐心等待，精准出击',
    style: 'Swing Trading',
    styleZh: '波段交易',
    risk: 2,
    horizon: 'Medium',
    horizonZh: '中线',
    icon: '◎',
  },
  scalper: {
    name: 'THE SCALPER',
    nameZh: '闪电侠',
    color: '#F59E0B',
    colorLight: '#FCD34D',
    master: 'Paul Rotter',
    masterZh: 'Paul Rotter',
    tagline: 'Speed is the ultimate edge',
    taglineZh: '速度就是最大的优势',
    style: 'Scalping',
    styleZh: '超短线',
    risk: 3,
    horizon: 'Short',
    horizonZh: '短线',
    icon: '⚡',
  },
  whale: {
    name: 'THE WHALE',
    nameZh: '巨鲸',
    color: '#06B6D4',
    colorLight: '#67E8F9',
    master: 'George Soros',
    masterZh: 'George Soros',
    tagline: 'Big conviction, big positions',
    taglineZh: '强信念，大仓位',
    style: 'Macro Trading',
    styleZh: '宏观交易',
    risk: 4,
    horizon: 'Medium',
    horizonZh: '中线',
    icon: '🐋',
  },
  analyst: {
    name: 'THE ANALYST',
    nameZh: '数据科学家',
    color: '#8B5CF6',
    colorLight: '#C4B5FD',
    master: 'Jim Simons',
    masterZh: 'Jim Simons',
    tagline: 'Data reveals what intuition hides',
    taglineZh: '数据揭示直觉隐藏的真相',
    style: 'Quantitative',
    styleZh: '量化交易',
    risk: 2,
    horizon: 'Medium',
    horizonZh: '中线',
    icon: '📊',
  },
  contrarian: {
    name: 'THE CONTRARIAN',
    nameZh: '逆行者',
    color: '#EF4444',
    colorLight: '#FCA5A5',
    master: 'Michael Burry',
    masterZh: 'Michael Burry',
    tagline: 'Be fearful when others are greedy',
    taglineZh: '别人贪婪时恐惧',
    style: 'Mean Reversion',
    styleZh: '均值回归',
    risk: 4,
    horizon: 'Medium',
    horizonZh: '中线',
    icon: '↺',
  },
  hodler: {
    name: 'THE HODLER',
    nameZh: '钻石手',
    color: '#10B981',
    colorLight: '#6EE7B7',
    master: 'Warren Buffett',
    masterZh: 'Warren Buffett',
    tagline: 'Time in the market beats timing',
    taglineZh: '持有时间胜过择时',
    style: 'Buy & Hold',
    styleZh: '买入持有',
    risk: 1,
    horizon: 'Long',
    horizonZh: '长线',
    icon: '◇',
  },
  degen: {
    name: 'THE DEGEN',
    nameZh: '赌神',
    color: '#F97316',
    colorLight: '#FDBA74',
    master: 'Richard Dennis',
    masterZh: 'Richard Dennis',
    tagline: 'Fortune favors the bold',
    taglineZh: '财富青睐勇敢者',
    style: 'High Leverage',
    styleZh: '高杠杆',
    risk: 5,
    horizon: 'Short',
    horizonZh: '短线',
    icon: '🔥',
  },
  strategist: {
    name: 'THE STRATEGIST',
    nameZh: '棋手',
    color: '#6366F1',
    colorLight: '#A5B4FC',
    master: 'Ray Dalio',
    masterZh: 'Ray Dalio',
    tagline: 'Diversify, balance, endure',
    taglineZh: '分散、平衡、持久',
    style: 'Risk Parity',
    styleZh: '风险平价',
    risk: 2,
    horizon: 'Long',
    horizonZh: '长线',
    icon: '♟',
  },
  copycat: {
    name: 'THE COPYCAT',
    nameZh: '跟单达人',
    color: '#EC4899',
    colorLight: '#F9A8D4',
    master: 'Peter Lynch',
    masterZh: 'Peter Lynch',
    tagline: 'Learn from the best, profit with the rest',
    taglineZh: '跟随高手，复制成功',
    style: 'Copy Trading',
    styleZh: '跟单交易',
    risk: 3,
    horizon: 'Medium',
    horizonZh: '中线',
    icon: '👥',
  },
  tourist: {
    name: 'THE TOURIST',
    nameZh: '币圈游客',
    color: '#F59E0B',
    colorLight: '#FCD34D',
    master: 'Your Coworker',
    masterZh: '你的同事',
    tagline: 'Trust me bro, to the moon',
    taglineZh: '相信我，这个要上月球',
    style: 'Vibes-Based',
    styleZh: '凭感觉投资',
    risk: 3,
    horizon: 'Short',
    horizonZh: '短线',
    icon: '🧭',
  },
  paperhands: {
    name: 'THE PAPER HANDS',
    nameZh: '纸手',
    color: '#94A3B8',
    colorLight: '#CBD5E1',
    master: 'Everyone Who Panic Sold',
    masterZh: '所有恐慌卖出的人',
    tagline: "I'll buy back when it dips",
    taglineZh: '等它回调我就买回来',
    style: 'Panic Exit',
    styleZh: '恐慌退出',
    risk: 1,
    horizon: 'Short',
    horizonZh: '短线',
    icon: '🧻',
  },
  narrator: {
    name: 'THE NARRATOR',
    nameZh: '叙事者',
    color: '#F43F5E',
    colorLight: '#FDA4AF',
    master: 'Cathie Wood',
    masterZh: 'Cathie Wood',
    tagline: 'The story drives the trade',
    taglineZh: '故事驱动交易',
    style: 'Narrative Trading',
    styleZh: '叙事交易',
    risk: 4,
    horizon: 'Long',
    horizonZh: '长线',
    icon: '📖',
  },
}

export async function GET(request: NextRequest) {
  const rateLimitResp = await checkRateLimit(request, RateLimitPresets.public)
  if (rateLimitResp) return rateLimitResp

  const { searchParams } = new URL(request.url)
  const typeId = (searchParams.get('type') || 'sniper').slice(0, 20)
  const match = parseInt((searchParams.get('match') || '85').slice(0, 20), 10)
  const lang = (searchParams.get('lang') || 'en').slice(0, 20)

  const t = TYPES[typeId] || TYPES.sniper
  const isZh = lang === 'zh'
  const typeName = isZh ? t.nameZh : t.name
  const masterName = isZh ? t.masterZh : t.master
  const tagline = isZh ? t.taglineZh : t.tagline
  const styleName = isZh ? t.styleZh : t.style
  const matchClamped = Math.min(99, Math.max(60, match))

  return new ImageResponse(
    <div
      style={{
        width: 1200,
        height: 630,
        display: 'flex',
        position: 'relative',
        overflow: 'hidden',
        background: '#08080C',
        fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
      }}
    >
      {/* Cinematic gradient background — type-colored */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          background: `radial-gradient(ellipse 70% 60% at 30% 40%, ${t.color}18 0%, transparent 60%), radial-gradient(ellipse 50% 50% at 80% 70%, ${t.color}0C 0%, transparent 60%)`,
        }}
      />

      {/* Subtle noise texture overlay */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          background:
            'linear-gradient(180deg, rgba(255,255,255,0.02) 0%, transparent 50%, rgba(0,0,0,0.3) 100%)',
        }}
      />

      {/* Top accent line */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: 3,
          display: 'flex',
          background: `linear-gradient(90deg, transparent 0%, ${t.color} 30%, ${t.colorLight} 50%, ${t.color} 70%, transparent 100%)`,
        }}
      />

      {/* Main layout — two columns */}
      <div
        style={{
          position: 'relative',
          display: 'flex',
          width: '100%',
          height: '100%',
          padding: '48px 56px',
          zIndex: 1,
        }}
      >
        {/* Left column — type identity */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            flex: 1.4,
            justifyContent: 'space-between',
          }}
        >
          {/* Top: Arena branding */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div
              style={{
                width: 6,
                height: 6,
                borderRadius: 999,
                background: t.color,
                display: 'flex',
              }}
            />
            <span
              style={{
                fontSize: 13,
                fontWeight: 800,
                color: 'rgba(255,255,255,0.5)',
                letterSpacing: '2px',
              }}
            >
              ARENA
            </span>
            <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.25)', marginLeft: 4 }}>
              Trading Personality
            </span>
          </div>

          {/* Center: Type name — the hero */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <span
              style={{
                fontSize: 64,
                fontWeight: 900,
                color: t.colorLight,
                letterSpacing: '-2px',
                lineHeight: 1,
                display: 'flex',
              }}
            >
              {typeName}
            </span>
            <span
              style={{
                fontSize: 18,
                color: 'rgba(255,255,255,0.45)',
                fontStyle: 'italic',
                lineHeight: 1.4,
                display: 'flex',
                maxWidth: 500,
              }}
            >
              &ldquo;{tagline}&rdquo;
            </span>
          </div>

          {/* Bottom: Style + Risk row */}
          <div style={{ display: 'flex', gap: 24, alignItems: 'flex-end' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  color: 'rgba(255,255,255,0.3)',
                  letterSpacing: '1.5px',
                }}
              >
                STYLE
              </span>
              <span style={{ fontSize: 16, fontWeight: 700, color: 'rgba(255,255,255,0.8)' }}>
                {styleName}
              </span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  color: 'rgba(255,255,255,0.3)',
                  letterSpacing: '1.5px',
                }}
              >
                RISK
              </span>
              <div style={{ display: 'flex', gap: 3 }}>
                {Array.from({ length: 5 }, (_, i) => (
                  <div
                    key={i}
                    style={{
                      width: 16,
                      height: 5,
                      borderRadius: 3,
                      display: 'flex',
                      background: i < t.risk ? t.color : 'rgba(255,255,255,0.1)',
                    }}
                  />
                ))}
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  color: 'rgba(255,255,255,0.3)',
                  letterSpacing: '1.5px',
                }}
              >
                HORIZON
              </span>
              <span style={{ fontSize: 16, fontWeight: 700, color: 'rgba(255,255,255,0.8)' }}>
                {isZh ? t.horizonZh : t.horizon}
              </span>
            </div>
          </div>
        </div>

        {/* Right column — match score + master */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            flex: 0.8,
            alignItems: 'flex-end',
            justifyContent: 'space-between',
          }}
        >
          {/* Match percentage — oversized accent number */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 0 }}>
            <span
              style={{
                fontSize: 120,
                fontWeight: 900,
                color: t.color,
                letterSpacing: '-6px',
                lineHeight: 0.85,
                display: 'flex',
              }}
            >
              {matchClamped}
            </span>
            <span
              style={{
                fontSize: 20,
                fontWeight: 700,
                color: t.colorLight,
                letterSpacing: '3px',
                marginTop: -4,
                display: 'flex',
              }}
            >
              % MATCH
            </span>
          </div>

          {/* Master card */}
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
              padding: '16px 20px',
              borderRadius: 12,
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.08)',
              maxWidth: 280,
              alignItems: 'flex-end',
              textAlign: 'right',
            }}
          >
            <span
              style={{
                fontSize: 10,
                fontWeight: 700,
                color: 'rgba(255,255,255,0.3)',
                letterSpacing: '1.5px',
                display: 'flex',
              }}
            >
              {isZh ? '传奇匹配' : 'LEGENDARY MATCH'}
            </span>
            <span
              style={{
                fontSize: 22,
                fontWeight: 900,
                color: 'rgba(255,255,255,0.9)',
                lineHeight: 1.1,
                display: 'flex',
              }}
            >
              {masterName}
            </span>
          </div>

          {/* CTA */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 13, color: 'rgba(255,255,255,0.35)' }}>
              {isZh ? '测测你是什么类型 →' : 'Take the quiz →'}
            </span>
            <span style={{ fontSize: 13, fontWeight: 700, color: t.color }}>arenafi.org/quiz</span>
          </div>
        </div>
      </div>
    </div>,
    {
      width: 1200,
      height: 630,
      headers: {
        'Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=604800',
      },
    }
  )
}
