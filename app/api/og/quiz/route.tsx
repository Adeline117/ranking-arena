/**
 * OG image for Trading Personality Quiz results
 * GET /api/og/quiz?type=sniper&match=87&lang=en
 *
 * Clean light-themed social card matching Arena website style.
 * White background, type-colored accents, no Unicode icons (they don't render in OG).
 * Designed to look native to arenafi.org when shared on X/Twitter/Telegram.
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
    colorBg: string
    master: string
    masterZh: string
    tagline: string
    taglineZh: string
    style: string
    styleZh: string
    risk: number
    horizon: string
    horizonZh: string
  }
> = {
  sniper: {
    name: 'THE SNIPER',
    nameZh: '\u7CBE\u51C6\u72D9\u51FB\u624B',
    color: '#8B5CF6',
    colorLight: '#C4B5FD',
    colorBg: '#F5F3FF',
    master: 'Jesse Livermore',
    masterZh: 'Jesse Livermore',
    tagline: 'Patient precision, perfect timing',
    taglineZh: '\u8010\u5FC3\u7B49\u5F85\uFF0C\u7CBE\u51C6\u51FA\u51FB',
    style: 'Swing Trading',
    styleZh: '\u6CE2\u6BB5\u4EA4\u6613',
    risk: 2,
    horizon: 'Medium',
    horizonZh: '\u4E2D\u7EBF',
  },
  scalper: {
    name: 'THE SCALPER',
    nameZh: '\u95EA\u7535\u4FA0',
    color: '#3B82F6',
    colorLight: '#93C5FD',
    colorBg: '#EFF6FF',
    master: 'Paul Rotter',
    masterZh: 'Paul Rotter',
    tagline: 'Speed is the ultimate edge',
    taglineZh: '\u901F\u5EA6\u5C31\u662F\u6700\u5927\u7684\u4F18\u52BF',
    style: 'Scalping',
    styleZh: '\u8D85\u77ED\u7EBF',
    risk: 3,
    horizon: 'Short',
    horizonZh: '\u77ED\u7EBF',
  },
  whale: {
    name: 'THE WHALE',
    nameZh: '\u5DE8\u9CB8',
    color: '#16A34A',
    colorLight: '#86EFAC',
    colorBg: '#F0FDF4',
    master: 'George Soros',
    masterZh: 'George Soros',
    tagline: 'Big conviction, big positions',
    taglineZh: '\u5F3A\u4FE1\u5FF5\uFF0C\u5927\u4ED3\u4F4D',
    style: 'Macro Trading',
    styleZh: '\u5B8F\u89C2\u4EA4\u6613',
    risk: 4,
    horizon: 'Medium',
    horizonZh: '\u4E2D\u7EBF',
  },
  analyst: {
    name: 'THE ANALYST',
    nameZh: '\u6570\u636E\u79D1\u5B66\u5BB6',
    color: '#7C3AED',
    colorLight: '#C4B5FD',
    colorBg: '#F5F3FF',
    master: 'Jim Simons',
    masterZh: 'Jim Simons',
    tagline: 'Data reveals what intuition hides',
    taglineZh: '\u6570\u636E\u63ED\u793A\u76F4\u89C9\u9690\u85CF\u7684\u771F\u76F8',
    style: 'Quantitative',
    styleZh: '\u91CF\u5316\u4EA4\u6613',
    risk: 2,
    horizon: 'Medium',
    horizonZh: '\u4E2D\u7EBF',
  },
  contrarian: {
    name: 'THE CONTRARIAN',
    nameZh: '\u9006\u884C\u8005',
    color: '#EF4444',
    colorLight: '#FCA5A5',
    colorBg: '#FEF2F2',
    master: 'Michael Burry',
    masterZh: 'Michael Burry',
    tagline: 'Be fearful when others are greedy',
    taglineZh: '\u522B\u4EBA\u8D2A\u5A6A\u65F6\u6050\u60E7',
    style: 'Mean Reversion',
    styleZh: '\u5747\u503C\u56DE\u5F52',
    risk: 4,
    horizon: 'Medium',
    horizonZh: '\u4E2D\u7EBF',
  },
  hodler: {
    name: 'THE HODLer',
    nameZh: '\u94BB\u77F3\u624B',
    color: '#10B981',
    colorLight: '#6EE7B7',
    colorBg: '#ECFDF5',
    master: 'Warren Buffett',
    masterZh: 'Warren Buffett',
    tagline: 'Time in the market beats timing',
    taglineZh: '\u6301\u6709\u65F6\u95F4\u80DC\u8FC7\u62E9\u65F6',
    style: 'Buy & Hold',
    styleZh: '\u4E70\u5165\u6301\u6709',
    risk: 1,
    horizon: 'Long',
    horizonZh: '\u957F\u7EBF',
  },
  degen: {
    name: 'THE DEGEN',
    nameZh: '\u8D4C\u795E',
    color: '#DC2626',
    colorLight: '#FCA5A5',
    colorBg: '#FEF2F2',
    master: 'Richard Dennis',
    masterZh: 'Richard Dennis',
    tagline: 'Fortune favors the bold',
    taglineZh: '\u8D22\u5BCC\u9752\u7750\u52C7\u6562\u8005',
    style: 'High Leverage',
    styleZh: '\u9AD8\u6760\u6746',
    risk: 5,
    horizon: 'Short',
    horizonZh: '\u77ED\u7EBF',
  },
  strategist: {
    name: 'THE STRATEGIST',
    nameZh: '\u68CB\u624B',
    color: '#6D28D9',
    colorLight: '#A78BFA',
    colorBg: '#F5F3FF',
    master: 'Ray Dalio',
    masterZh: 'Ray Dalio',
    tagline: 'Diversify, balance, endure',
    taglineZh: '\u5206\u6563\u3001\u5E73\u8861\u3001\u6301\u4E45',
    style: 'Risk Parity',
    styleZh: '\u98CE\u9669\u5E73\u4EF7',
    risk: 2,
    horizon: 'Long',
    horizonZh: '\u957F\u7EBF',
  },
  copycat: {
    name: 'THE COPY TRADER',
    nameZh: '\u8DDF\u5355\u8FBE\u4EBA',
    color: '#2563EB',
    colorLight: '#93C5FD',
    colorBg: '#EFF6FF',
    master: 'Mark Minervini',
    masterZh: 'Mark Minervini',
    tagline: 'Learn from the best, profit with the rest',
    taglineZh: '\u8DDF\u968F\u9AD8\u624B\uFF0C\u590D\u5236\u6210\u529F',
    style: 'Copy Trading',
    styleZh: '\u8DDF\u5355\u4EA4\u6613',
    risk: 3,
    horizon: 'Medium',
    horizonZh: '\u4E2D\u7EBF',
  },
  tourist: {
    name: 'THE TOURIST',
    nameZh: '\u5E01\u5708\u6E38\u5BA2',
    color: '#60A5FA',
    colorLight: '#BFDBFE',
    colorBg: '#EFF6FF',
    master: 'Your Coworker',
    masterZh: '\u4F60\u7684\u540C\u4E8B',
    tagline: 'Trust me bro, to the moon',
    taglineZh: '\u76F8\u4FE1\u6211\uFF0C\u8FD9\u4E2A\u8981\u4E0A\u6708\u7403',
    style: 'Vibes-Based',
    styleZh: '\u51ED\u611F\u89C9\u6295\u8D44',
    risk: 3,
    horizon: 'Short',
    horizonZh: '\u77ED\u7EBF',
  },
  paperhands: {
    name: 'THE PAPER HANDS',
    nameZh: '\u7EB8\u624B',
    color: '#F87171',
    colorLight: '#FCA5A5',
    colorBg: '#FEF2F2',
    master: 'Everyone Who Sold BTC Under $1,000',
    masterZh: '\u6240\u6709\u5728$1,000\u4EE5\u4E0B\u5356\u51FABTC\u7684\u4EBA',
    tagline: "I'll buy back when it dips",
    taglineZh: '\u7B49\u5B83\u56DE\u8C03\u6211\u5C31\u4E70\u56DE\u6765',
    style: 'Panic Exit',
    styleZh: '\u6050\u614C\u9000\u51FA',
    risk: 1,
    horizon: 'Short',
    horizonZh: '\u77ED\u7EBF',
  },
  narrator: {
    name: 'THE NARRATIVE TRADER',
    nameZh: '\u53D9\u4E8B\u8005',
    color: '#22C55E',
    colorLight: '#86EFAC',
    colorBg: '#F0FDF4',
    master: 'Cathie Wood',
    masterZh: 'Cathie Wood',
    tagline: 'The story drives the trade',
    taglineZh: '\u6545\u4E8B\u9A71\u52A8\u4EA4\u6613',
    style: 'Narrative Trading',
    styleZh: '\u53D9\u4E8B\u4EA4\u6613',
    risk: 4,
    horizon: 'Long',
    horizonZh: '\u957F\u7EBF',
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
  const horizonName = isZh ? t.horizonZh : t.horizon
  const matchClamped = Math.min(99, Math.max(60, match))

  return new ImageResponse(
    <div
      style={{
        width: 1200,
        height: 630,
        display: 'flex',
        flexDirection: 'column',
        position: 'relative',
        overflow: 'hidden',
        background: '#FFFFFF',
        fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
      }}
    >
      {/* Top accent bar — type-colored */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: 5,
          display: 'flex',
          background: t.color,
        }}
      />

      {/* Main content area */}
      <div
        style={{
          display: 'flex',
          width: '100%',
          height: '100%',
          padding: '48px 56px 0 56px',
        }}
      >
        {/* LEFT COLUMN (55%) — branding + type name + tagline */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            width: '55%',
            justifyContent: 'flex-start',
            paddingRight: 40,
            gap: 0,
          }}
        >
          {/* Arena branding — small, gray */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
            <span
              style={{
                fontSize: 14,
                fontWeight: 800,
                color: '#9CA3AF',
                letterSpacing: '3px',
              }}
            >
              ARENA
            </span>
            <div
              style={{
                width: 1,
                height: 14,
                background: '#E5E7EB',
                display: 'flex',
              }}
            />
            <span
              style={{
                fontSize: 13,
                color: '#9CA3AF',
                letterSpacing: '0.5px',
              }}
            >
              {isZh ? '\u4EA4\u6613\u4EBA\u683C\u6D4B\u8BD5' : 'Trading Personality Quiz'}
            </span>
          </div>

          {/* Type name — large, bold, colored */}
          <span
            style={{
              fontSize: 64,
              fontWeight: 900,
              color: t.color,
              letterSpacing: '-2px',
              lineHeight: 1.05,
              display: 'flex',
              marginTop: 24,
            }}
          >
            {typeName}
          </span>

          {/* Tagline — italic, gray */}
          <span
            style={{
              fontSize: 20,
              color: '#6B7280',
              fontStyle: 'italic',
              lineHeight: 1.4,
              display: 'flex',
              maxWidth: 480,
              marginTop: 16,
            }}
          >
            &ldquo;{tagline}&rdquo;
          </span>
        </div>

        {/* RIGHT COLUMN (45%) — match % + master card + CTA */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            width: '45%',
            alignItems: 'flex-end',
            justifyContent: 'flex-start',
            paddingLeft: 24,
            gap: 0,
          }}
        >
          {/* Match percentage — large, colored */}
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'flex-end',
              gap: 0,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
              <span
                style={{
                  fontSize: 88,
                  fontWeight: 900,
                  color: t.color,
                  letterSpacing: '-4px',
                  lineHeight: 1,
                  display: 'flex',
                }}
              >
                {matchClamped}
              </span>
              <span
                style={{
                  fontSize: 32,
                  fontWeight: 800,
                  color: t.color,
                  lineHeight: 1,
                  display: 'flex',
                }}
              >
                %
              </span>
            </div>
            <span
              style={{
                fontSize: 14,
                fontWeight: 700,
                color: '#9CA3AF',
                letterSpacing: '3px',
                marginTop: 4,
                display: 'flex',
              }}
            >
              MATCH
            </span>
          </div>

          {/* Master card — light gray card with subtle border */}
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              padding: '20px 24px',
              borderRadius: 16,
              background: t.colorBg,
              border: `1px solid ${t.colorLight}`,
              width: '100%',
              maxWidth: 380,
              alignItems: 'flex-end',
              marginTop: 24,
            }}
          >
            <span
              style={{
                fontSize: 11,
                fontWeight: 700,
                color: t.color,
                letterSpacing: '2px',
                display: 'flex',
              }}
            >
              {isZh ? 'LEGENDARY MATCH' : 'LEGENDARY MATCH'}
            </span>
            <span
              style={{
                fontSize: 24,
                fontWeight: 900,
                color: '#1F2937',
                lineHeight: 1.2,
                display: 'flex',
              }}
            >
              {masterName}
            </span>
            <span
              style={{
                fontSize: 12,
                color: '#9CA3AF',
                display: 'flex',
              }}
            >
              {isZh
                ? '\u4F60\u7684\u4EA4\u6613\u98CE\u683C\u5339\u914D'
                : 'Your trading style match'}
            </span>
          </div>

          {/* CTA — brand purple, no Unicode arrows */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              marginTop: 24,
            }}
          >
            <span
              style={{
                fontSize: 14,
                color: '#9CA3AF',
              }}
            >
              {isZh ? '\u6D4B\u6D4B\u4F60\u662F\u4EC0\u4E48\u7C7B\u578B' : 'Take the quiz'}
            </span>
            <span
              style={{
                fontSize: 15,
                fontWeight: 800,
                color: '#6C5CE7',
                letterSpacing: '0.5px',
              }}
            >
              arenafi.org/quiz
            </span>
          </div>
        </div>
      </div>

      {/* Bottom data strip — STYLE | RISK gauge | HORIZON */}
      <div
        style={{
          display: 'flex',
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
          height: 72,
          background: '#F9FAFB',
          borderTop: '1px solid #E5E7EB',
          padding: '0 56px',
          alignItems: 'center',
          gap: 48,
        }}
      >
        {/* STYLE */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              color: '#9CA3AF',
              letterSpacing: '1.5px',
            }}
          >
            STYLE
          </span>
          <span
            style={{
              fontSize: 16,
              fontWeight: 700,
              color: '#374151',
            }}
          >
            {styleName}
          </span>
        </div>

        {/* Separator */}
        <div
          style={{
            width: 1,
            height: 32,
            background: '#E5E7EB',
            display: 'flex',
          }}
        />

        {/* RISK gauge */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              color: '#9CA3AF',
              letterSpacing: '1.5px',
            }}
          >
            RISK
          </span>
          <div style={{ display: 'flex', gap: 4 }}>
            {Array.from({ length: 5 }, (_, i) => (
              <div
                key={i}
                style={{
                  width: 20,
                  height: 6,
                  borderRadius: 3,
                  display: 'flex',
                  background: i < t.risk ? t.color : '#E5E7EB',
                }}
              />
            ))}
          </div>
        </div>

        {/* Separator */}
        <div
          style={{
            width: 1,
            height: 32,
            background: '#E5E7EB',
            display: 'flex',
          }}
        />

        {/* HORIZON */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              color: '#9CA3AF',
              letterSpacing: '1.5px',
            }}
          >
            HORIZON
          </span>
          <span
            style={{
              fontSize: 16,
              fontWeight: 700,
              color: '#374151',
            }}
          >
            {horizonName}
          </span>
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
