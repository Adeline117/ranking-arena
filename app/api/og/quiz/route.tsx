/**
 * OG image for Trading Personality Quiz results
 * GET /api/og/quiz?type=sniper&match=87&lang=en
 *
 * Renders a 1200x630 social card matching Arena's rank card style.
 * Edge runtime, no DB calls, highly cacheable.
 */

import { ImageResponse } from 'next/og'
import { NextRequest } from 'next/server'
import { checkRateLimit, RateLimitPresets } from '@/lib/api'

export const runtime = 'edge'

const TYPES: Record<string, {
  name: string; nameZh: string; color: string; gradient: string
  master: string; masterZh: string; tagline: string; taglineZh: string
  style: string; styleZh: string; risk: number; horizon: string; horizonZh: string
}> = {
  sniper:     { name: 'The Sniper',     nameZh: '精准狙击手', color: '#3B82F6', gradient: 'linear-gradient(135deg, #3B82F6 0%, #6366F1 100%)', master: 'Jesse Livermore',  masterZh: 'Jesse Livermore',  tagline: 'Patient precision, perfect timing',        taglineZh: '耐心等待，精准出击',     style: 'Swing Trading',        styleZh: '波段交易',     risk: 2, horizon: 'Medium',   horizonZh: '中线' },
  scalper:    { name: 'The Scalper',    nameZh: '闪电侠',     color: '#F59E0B', gradient: 'linear-gradient(135deg, #F59E0B 0%, #F97316 100%)', master: 'Paul Rotter',       masterZh: 'Paul Rotter',       tagline: 'Speed is the ultimate edge',               taglineZh: '速度就是最大的优势',     style: 'Scalping',             styleZh: '超短线',       risk: 3, horizon: 'Short',    horizonZh: '短线' },
  whale:      { name: 'The Whale',      nameZh: '巨鲸',       color: '#06B6D4', gradient: 'linear-gradient(135deg, #06B6D4 0%, #0891B2 100%)', master: 'George Soros',      masterZh: 'George Soros',      tagline: 'Big conviction, big positions',             taglineZh: '强信念，大仓位',         style: 'Macro Trading',        styleZh: '宏观交易',     risk: 4, horizon: 'Medium',   horizonZh: '中线' },
  analyst:    { name: 'The Analyst',    nameZh: '数据科学家', color: '#8B5CF6', gradient: 'linear-gradient(135deg, #8B5CF6 0%, #7C3AED 100%)', master: 'Jim Simons',        masterZh: 'Jim Simons',        tagline: 'Data reveals what intuition hides',        taglineZh: '数据揭示直觉隐藏的真相', style: 'Quantitative',         styleZh: '量化交易',     risk: 2, horizon: 'Medium',   horizonZh: '中线' },
  contrarian: { name: 'The Contrarian', nameZh: '逆行者',     color: '#EF4444', gradient: 'linear-gradient(135deg, #EF4444 0%, #DC2626 100%)', master: 'Michael Burry',     masterZh: 'Michael Burry',     tagline: 'Be fearful when others are greedy',        taglineZh: '别人贪婪时恐惧',         style: 'Mean Reversion',       styleZh: '均值回归',     risk: 4, horizon: 'Medium',   horizonZh: '中线' },
  hodler:     { name: 'The HODLer',     nameZh: '钻石手',     color: '#10B981', gradient: 'linear-gradient(135deg, #10B981 0%, #059669 100%)', master: 'Warren Buffett',    masterZh: 'Warren Buffett',    tagline: 'Time in the market beats timing',          taglineZh: '持有时间胜过择时',       style: 'Buy & Hold',           styleZh: '买入持有',     risk: 1, horizon: 'Long',     horizonZh: '长线' },
  degen:      { name: 'The Degen',      nameZh: '赌神',       color: '#F97316', gradient: 'linear-gradient(135deg, #F97316 0%, #EF4444 100%)', master: 'Richard Dennis',    masterZh: 'Richard Dennis',    tagline: 'Fortune favors the bold',                  taglineZh: '财富青睐勇敢者',         style: 'High Leverage',        styleZh: '高杠杆',       risk: 5, horizon: 'Short',    horizonZh: '短线' },
  strategist: { name: 'The Strategist', nameZh: '棋手',       color: '#6366F1', gradient: 'linear-gradient(135deg, #6366F1 0%, #4F46E5 100%)', master: 'Ray Dalio',         masterZh: 'Ray Dalio',         tagline: 'Diversify, balance, endure',               taglineZh: '分散、平衡、持久',       style: 'Risk Parity',          styleZh: '风险平价',     risk: 2, horizon: 'Long',     horizonZh: '长线' },
}

const C = {
  bgTop: '#0A0A0F',
  bgBottom: '#1A1A2E',
  card: '#12121F',
  white: '#FFFFFF',
  offWhite: '#EDEDED',
  dim: 'rgba(255,255,255,0.50)',
  dimmer: 'rgba(255,255,255,0.28)',
  gold: '#D4AF37',
  goldLight: '#F0D060',
  goldDim: 'rgba(212,175,55,0.15)',
  purple: '#8B5CF6',
  border: 'rgba(139,92,246,0.25)',
}

function riskDots(level: number, color: string) {
  return Array.from({ length: 5 }, (_, i) => (
    <div
      key={i}
      style={{
        width: 10,
        height: 10,
        borderRadius: 999,
        background: i < level ? color : 'rgba(255,255,255,0.12)',
        display: 'flex',
      }}
    />
  ))
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
  const horizonName = isZh ? t.horizonZh : t.horizon
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
        <div style={{ position: 'absolute', top: -120, left: -80, width: 480, height: 480, background: `radial-gradient(circle, ${t.color}20 0%, transparent 70%)`, display: 'flex' }} />
        <div style={{ position: 'absolute', bottom: -100, right: -60, width: 400, height: 400, background: `radial-gradient(circle, ${C.goldDim} 0%, transparent 70%)`, display: 'flex' }} />

        {/* Top accent bar */}
        <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 3, background: `linear-gradient(90deg, ${t.color} 0%, ${C.gold} 50%, ${t.color} 100%)`, display: 'flex' }} />

        {/* Main content */}
        <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', height: '100%', padding: '36px 56px 32px', zIndex: 1 }}>

          {/* Top row: Logo + Type badge */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ width: 8, height: 8, borderRadius: 999, background: C.gold, display: 'flex' }} />
              <span style={{ fontSize: 16, fontWeight: 800, color: C.gold, letterSpacing: '1.5px' }}>ARENA</span>
              <span style={{ fontSize: 13, color: C.dimmer, marginLeft: 4 }}>arenafi.org</span>
            </div>
            <div style={{ display: 'flex', padding: '5px 14px', borderRadius: 8, background: `${t.color}18`, border: `1px solid ${t.color}35` }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: t.color, letterSpacing: '0.5px' }}>
                {isZh ? '交易人格测试' : 'TRADING PERSONALITY'}
              </span>
            </div>
          </div>

          {/* Type name + tagline */}
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 20, marginBottom: 6 }}>
            <span style={{ fontSize: 48, fontWeight: 900, color: t.color, letterSpacing: '-1px', display: 'flex' }}>
              {typeName}
            </span>
            <span style={{ fontSize: 36, fontWeight: 900, color: `${t.color}CC`, display: 'flex' }}>
              {matchClamped}%
            </span>
          </div>
          <div style={{ display: 'flex', marginBottom: 20 }}>
            <span style={{ fontSize: 16, color: C.dim, fontStyle: 'italic' }}>
              &ldquo;{tagline}&rdquo;
            </span>
          </div>

          {/* 4-card stat row (matching rank card style) */}
          <div style={{ display: 'flex', gap: 14, flex: 1 }}>
            {/* Master card (gold accent) */}
            <div style={{
              display: 'flex', flexDirection: 'column', flex: 1.5,
              padding: '18px 22px', borderRadius: 16,
              background: C.goldDim, border: `1px solid rgba(212,175,55,0.30)`, gap: 6,
            }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: C.goldLight, letterSpacing: '2px', display: 'flex' }}>
                {isZh ? '传奇大师' : 'LEGENDARY MATCH'}
              </span>
              <span style={{ fontSize: 28, fontWeight: 900, color: C.goldLight, lineHeight: 1.1, display: 'flex' }}>
                {masterName}
              </span>
              <span style={{ fontSize: 13, color: C.dim, lineHeight: 1.3, display: 'flex', marginTop: 2 }}>
                {isZh ? '你的交易风格灵魂伴侣' : 'Your trading style soulmate'}
              </span>
            </div>

            {/* Style card */}
            <div style={{
              display: 'flex', flexDirection: 'column', flex: 1,
              padding: '18px 22px', borderRadius: 16,
              background: `${t.color}10`, border: `1px solid ${t.color}22`, gap: 6,
            }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: C.dimmer, letterSpacing: '2px', display: 'flex' }}>
                {isZh ? '交易风格' : 'STYLE'}
              </span>
              <span style={{ fontSize: 24, fontWeight: 900, color: t.color, lineHeight: 1.1, display: 'flex' }}>
                {styleName}
              </span>
              <span style={{ fontSize: 13, color: C.dim, display: 'flex', marginTop: 4 }}>
                {isZh ? '时间周期' : 'Horizon'}: {horizonName}
              </span>
            </div>

            {/* Risk card */}
            <div style={{
              display: 'flex', flexDirection: 'column', flex: 0.7,
              padding: '18px 22px', borderRadius: 16,
              background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', gap: 8,
            }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: C.dimmer, letterSpacing: '2px', display: 'flex' }}>
                {isZh ? '风险等级' : 'RISK'}
              </span>
              <span style={{ fontSize: 36, fontWeight: 900, color: C.offWhite, lineHeight: 1, display: 'flex' }}>
                {t.risk}/5
              </span>
              <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
                {riskDots(t.risk, t.color)}
              </div>
            </div>

            {/* Match card */}
            <div style={{
              display: 'flex', flexDirection: 'column', flex: 0.7,
              padding: '18px 22px', borderRadius: 16,
              background: `${t.color}10`, border: `1px solid ${t.color}22`, gap: 6,
            }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: C.dimmer, letterSpacing: '2px', display: 'flex' }}>
                {isZh ? '匹配度' : 'MATCH'}
              </span>
              <span style={{ fontSize: 48, fontWeight: 900, color: t.color, letterSpacing: '-2px', lineHeight: 1, display: 'flex' }}>
                {matchClamped}%
              </span>
            </div>
          </div>

          {/* Bottom row */}
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            marginTop: 18, paddingTop: 14, borderTop: '1px solid rgba(255,255,255,0.06)',
          }}>
            <span style={{ fontSize: 14, fontWeight: 600, color: C.dim }}>
              {isZh ? '测测你的交易人格' : 'Discover your trading personality'}
            </span>
            <span style={{ fontSize: 14, fontWeight: 700, color: t.color }}>
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
