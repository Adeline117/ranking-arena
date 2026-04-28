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
    nameZh: '\u7CBE\u51C6\u72D9\u51FB\u624B',
    color: '#8B5CF6',
    colorLight: '#C4B5FD',
    master: 'Jesse Livermore',
    masterZh: 'Jesse Livermore',
    tagline: 'Patient precision, perfect timing',
    taglineZh: '\u8010\u5FC3\u7B49\u5F85\uFF0C\u7CBE\u51C6\u51FA\u51FB',
    style: 'Swing Trading',
    styleZh: '\u6CE2\u6BB5\u4EA4\u6613',
    risk: 2,
    horizon: 'Medium',
    horizonZh: '\u4E2D\u7EBF',
    icon: '\u25CE',
  },
  scalper: {
    name: 'THE SCALPER',
    nameZh: '\u95EA\u7535\u4FA0',
    color: '#3B82F6',
    colorLight: '#93C5FD',
    master: 'Paul Rotter',
    masterZh: 'Paul Rotter',
    tagline: 'Speed is the ultimate edge',
    taglineZh: '\u901F\u5EA6\u5C31\u662F\u6700\u5927\u7684\u4F18\u52BF',
    style: 'Scalping',
    styleZh: '\u8D85\u77ED\u7EBF',
    risk: 3,
    horizon: 'Short',
    horizonZh: '\u77ED\u7EBF',
    icon: '\u26A1',
  },
  whale: {
    name: 'THE WHALE',
    nameZh: '\u5DE8\u9CB8',
    color: '#16A34A',
    colorLight: '#86EFAC',
    master: 'George Soros',
    masterZh: 'George Soros',
    tagline: 'Big conviction, big positions',
    taglineZh: '\u5F3A\u4FE1\u5FF5\uFF0C\u5927\u4ED3\u4F4D',
    style: 'Macro Trading',
    styleZh: '\u5B8F\u89C2\u4EA4\u6613',
    risk: 4,
    horizon: 'Medium',
    horizonZh: '\u4E2D\u7EBF',
    icon: '\u3030',
  },
  analyst: {
    name: 'THE ANALYST',
    nameZh: '\u6570\u636E\u79D1\u5B66\u5BB6',
    color: '#7C3AED',
    colorLight: '#C4B5FD',
    master: 'Jim Simons',
    masterZh: 'Jim Simons',
    tagline: 'Data reveals what intuition hides',
    taglineZh: '\u6570\u636E\u63ED\u793A\u76F4\u89C9\u9690\u85CF\u7684\u771F\u76F8',
    style: 'Quantitative',
    styleZh: '\u91CF\u5316\u4EA4\u6613',
    risk: 2,
    horizon: 'Medium',
    horizonZh: '\u4E2D\u7EBF',
    icon: '\u25A5',
  },
  contrarian: {
    name: 'THE CONTRARIAN',
    nameZh: '\u9006\u884C\u8005',
    color: '#EF4444',
    colorLight: '#FCA5A5',
    master: 'Michael Burry',
    masterZh: 'Michael Burry',
    tagline: 'Be fearful when others are greedy',
    taglineZh: '\u522B\u4EBA\u8D2A\u5A6A\u65F6\u6050\u60E7',
    style: 'Mean Reversion',
    styleZh: '\u5747\u503C\u56DE\u5F52',
    risk: 4,
    horizon: 'Medium',
    horizonZh: '\u4E2D\u7EBF',
    icon: '\u21BA',
  },
  hodler: {
    name: 'THE HODLer',
    nameZh: '\u94BB\u77F3\u624B',
    color: '#10B981',
    colorLight: '#6EE7B7',
    master: 'Warren Buffett',
    masterZh: 'Warren Buffett',
    tagline: 'Time in the market beats timing',
    taglineZh: '\u6301\u6709\u65F6\u95F4\u80DC\u8FC7\u62E9\u65F6',
    style: 'Buy & Hold',
    styleZh: '\u4E70\u5165\u6301\u6709',
    risk: 1,
    horizon: 'Long',
    horizonZh: '\u957F\u7EBF',
    icon: '\u25C7',
  },
  degen: {
    name: 'THE DEGEN',
    nameZh: '\u8D4C\u795E',
    color: '#DC2626',
    colorLight: '#FCA5A5',
    master: 'Richard Dennis',
    masterZh: 'Richard Dennis',
    tagline: 'Fortune favors the bold',
    taglineZh: '\u8D22\u5BCC\u9752\u7750\u52C7\u6562\u8005',
    style: 'High Leverage',
    styleZh: '\u9AD8\u6760\u6746',
    risk: 5,
    horizon: 'Short',
    horizonZh: '\u77ED\u7EBF',
    icon: '\u25B3',
  },
  strategist: {
    name: 'THE STRATEGIST',
    nameZh: '\u68CB\u624B',
    color: '#6D28D9',
    colorLight: '#A78BFA',
    master: 'Ray Dalio',
    masterZh: 'Ray Dalio',
    tagline: 'Diversify, balance, endure',
    taglineZh: '\u5206\u6563\u3001\u5E73\u8861\u3001\u6301\u4E45',
    style: 'Risk Parity',
    styleZh: '\u98CE\u9669\u5E73\u4EF7',
    risk: 2,
    horizon: 'Long',
    horizonZh: '\u957F\u7EBF',
    icon: '\u265F',
  },
  copycat: {
    name: 'THE COPY TRADER',
    nameZh: '\u8DDF\u5355\u8FBE\u4EBA',
    color: '#2563EB',
    colorLight: '#93C5FD',
    master: 'Mark Minervini',
    masterZh: 'Mark Minervini',
    tagline: 'Learn from the best, profit with the rest',
    taglineZh: '\u8DDF\u968F\u9AD8\u624B\uFF0C\u590D\u5236\u6210\u529F',
    style: 'Copy Trading',
    styleZh: '\u8DDF\u5355\u4EA4\u6613',
    risk: 3,
    horizon: 'Medium',
    horizonZh: '\u4E2D\u7EBF',
    icon: '\u229E',
  },
  tourist: {
    name: 'THE TOURIST',
    nameZh: '\u5E01\u5708\u6E38\u5BA2',
    color: '#60A5FA',
    colorLight: '#BFDBFE',
    master: 'Your Coworker',
    masterZh: '\u4F60\u7684\u540C\u4E8B',
    tagline: 'Trust me bro, to the moon',
    taglineZh: '\u76F8\u4FE1\u6211\uFF0C\u8FD9\u4E2A\u8981\u4E0A\u6708\u7403',
    style: 'Vibes-Based',
    styleZh: '\u51ED\u611F\u89C9\u6295\u8D44',
    risk: 3,
    horizon: 'Short',
    horizonZh: '\u77ED\u7EBF',
    icon: '\u25C8',
  },
  paperhands: {
    name: 'THE PAPER HANDS',
    nameZh: '\u7EB8\u624B',
    color: '#F87171',
    colorLight: '#FCA5A5',
    master: 'Everyone Who Sold BTC Under $1,000',
    masterZh: '\u6240\u6709\u5728$1,000\u4EE5\u4E0B\u5356\u51FABTC\u7684\u4EBA',
    tagline: "I'll buy back when it dips",
    taglineZh: '\u7B49\u5B83\u56DE\u8C03\u6211\u5C31\u4E70\u56DE\u6765',
    style: 'Panic Exit',
    styleZh: '\u6050\u614C\u9000\u51FA',
    risk: 1,
    horizon: 'Short',
    horizonZh: '\u77ED\u7EBF',
    icon: '\u2610',
  },
  narrator: {
    name: 'THE NARRATIVE TRADER',
    nameZh: '\u53D9\u4E8B\u8005',
    color: '#22C55E',
    colorLight: '#86EFAC',
    master: 'Cathie Wood',
    masterZh: 'Cathie Wood',
    tagline: 'The story drives the trade',
    taglineZh: '\u6545\u4E8B\u9A71\u52A8\u4EA4\u6613',
    style: 'Narrative Trading',
    styleZh: '\u53D9\u4E8B\u4EA4\u6613',
    risk: 4,
    horizon: 'Long',
    horizonZh: '\u957F\u7EBF',
    icon: '\u25B7',
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
      {/* Cinematic radial glow — primary from left-center */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          background: `radial-gradient(ellipse 80% 70% at 25% 45%, ${t.color}2E 0%, transparent 65%)`,
        }}
      />

      {/* Secondary subtle glow from bottom-right */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          background: `radial-gradient(ellipse 50% 50% at 85% 80%, ${t.color}14 0%, transparent 55%)`,
        }}
      />

      {/* Bottom vignette — fades to black */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          background:
            'linear-gradient(180deg, transparent 0%, transparent 55%, rgba(0,0,0,0.15) 75%, rgba(0,0,0,0.4) 100%)',
        }}
      />

      {/* Top edge highlight */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: 2,
          display: 'flex',
          background:
            'linear-gradient(90deg, rgba(255,255,255,0.03) 0%, rgba(255,255,255,0.06) 50%, rgba(255,255,255,0.03) 100%)',
        }}
      />

      {/* Top accent line — type-colored gradient */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: 3,
          display: 'flex',
          background: `linear-gradient(90deg, transparent 5%, ${t.color} 25%, ${t.colorLight} 50%, ${t.color} 75%, transparent 95%)`,
        }}
      />

      {/* Vertical divider line between columns */}
      <div
        style={{
          position: 'absolute',
          top: 60,
          bottom: 60,
          left: '60%',
          width: 1,
          display: 'flex',
          background:
            'linear-gradient(180deg, transparent 0%, rgba(255,255,255,0.06) 30%, rgba(255,255,255,0.06) 70%, transparent 100%)',
        }}
      />

      {/* Main layout — two columns */}
      <div
        style={{
          position: 'relative',
          display: 'flex',
          width: '100%',
          height: '100%',
          padding: '44px 56px',
          zIndex: 1,
        }}
      >
        {/* LEFT COLUMN (60%) — personality identity */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            width: '58%',
            justifyContent: 'space-between',
            paddingRight: 40,
          }}
        >
          {/* Top: Arena branding */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 999,
                  background: t.color,
                  display: 'flex',
                  boxShadow: `0 0 8px ${t.color}80`,
                }}
              />
              <span
                style={{
                  fontSize: 13,
                  fontWeight: 800,
                  color: 'rgba(255,255,255,0.5)',
                  letterSpacing: '3px',
                }}
              >
                ARENA
              </span>
            </div>
            <span
              style={{
                fontSize: 13,
                color: 'rgba(255,255,255,0.25)',
                letterSpacing: '0.5px',
                marginLeft: 14,
              }}
            >
              {isZh ? '\u4EA4\u6613\u4EBA\u683C\u6D4B\u8BD5' : 'Trading Personality'}
            </span>
          </div>

          {/* Center: Type icon + name — the hero */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {/* Type icon */}
            <span
              style={{
                fontSize: 36,
                color: t.color,
                lineHeight: 1,
                display: 'flex',
                opacity: 0.7,
              }}
            >
              {t.icon}
            </span>

            {/* Type name — massive */}
            <span
              style={{
                fontSize: 72,
                fontWeight: 900,
                color: t.colorLight,
                letterSpacing: '-3px',
                lineHeight: 1,
                display: 'flex',
              }}
            >
              {typeName}
            </span>

            {/* Tagline quote */}
            <span
              style={{
                fontSize: 18,
                color: 'rgba(255,255,255,0.4)',
                fontStyle: 'italic',
                lineHeight: 1.4,
                display: 'flex',
                maxWidth: 480,
                marginTop: 2,
              }}
            >
              &ldquo;{tagline}&rdquo;
            </span>
          </div>

          {/* Bottom: STYLE | RISK gauge | HORIZON data strip */}
          <div
            style={{
              display: 'flex',
              gap: 32,
              alignItems: 'flex-end',
            }}
          >
            {/* STYLE */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
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
              <span
                style={{
                  fontSize: 16,
                  fontWeight: 700,
                  color: 'rgba(255,255,255,0.8)',
                }}
              >
                {styleName}
              </span>
            </div>

            {/* Separator */}
            <div
              style={{
                width: 1,
                height: 28,
                background: 'rgba(255,255,255,0.1)',
                display: 'flex',
              }}
            />

            {/* RISK gauge */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
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
                      width: 18,
                      height: 6,
                      borderRadius: 3,
                      display: 'flex',
                      background: i < t.risk ? t.color : 'rgba(255,255,255,0.08)',
                    }}
                  />
                ))}
              </div>
            </div>

            {/* Separator */}
            <div
              style={{
                width: 1,
                height: 28,
                background: 'rgba(255,255,255,0.1)',
                display: 'flex',
              }}
            />

            {/* HORIZON */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
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
              <span
                style={{
                  fontSize: 16,
                  fontWeight: 700,
                  color: 'rgba(255,255,255,0.8)',
                }}
              >
                {isZh ? t.horizonZh : t.horizon}
              </span>
            </div>
          </div>
        </div>

        {/* RIGHT COLUMN (40%) — match score + master + CTA */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            width: '42%',
            alignItems: 'flex-end',
            justifyContent: 'space-between',
            paddingLeft: 32,
          }}
        >
          {/* Match percentage — prominent but balanced */}
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'flex-end',
              gap: 0,
            }}
          >
            <span
              style={{
                fontSize: 80,
                fontWeight: 900,
                color: t.colorLight,
                letterSpacing: '-4px',
                lineHeight: 0.9,
                display: 'flex',
              }}
            >
              {matchClamped}
            </span>
            <span
              style={{
                fontSize: 16,
                fontWeight: 700,
                color: t.color,
                letterSpacing: '4px',
                marginTop: 2,
                display: 'flex',
              }}
            >
              % MATCH
            </span>
          </div>

          {/* Master card — glass card */}
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
              padding: '20px 24px',
              borderRadius: 14,
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.08)',
              width: '100%',
              maxWidth: 340,
              alignItems: 'flex-end',
              textAlign: 'right',
            }}
          >
            <span
              style={{
                fontSize: 10,
                fontWeight: 700,
                color: t.color,
                letterSpacing: '2px',
                display: 'flex',
                opacity: 0.8,
              }}
            >
              {isZh ? '\u2666 \u4F20\u5947\u5339\u914D' : '\u2666 LEGENDARY MATCH'}
            </span>
            <span
              style={{
                fontSize: 24,
                fontWeight: 900,
                color: 'rgba(255,255,255,0.9)',
                lineHeight: 1.2,
                display: 'flex',
              }}
            >
              {masterName}
            </span>
            <span
              style={{
                fontSize: 12,
                color: 'rgba(255,255,255,0.3)',
                display: 'flex',
              }}
            >
              {isZh
                ? '\u4F60\u7684\u4EA4\u6613\u98CE\u683C\u5339\u914D'
                : 'Your trading style match'}
            </span>
          </div>

          {/* CTA — bottom-right */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <span
              style={{
                fontSize: 13,
                color: 'rgba(255,255,255,0.3)',
              }}
            >
              {isZh ? '\u6D4B\u6D4B\u4F60\u662F\u4EC0\u4E48\u7C7B\u578B' : 'Take the quiz'}
            </span>
            <span
              style={{
                fontSize: 13,
                color: t.color,
                fontWeight: 700,
              }}
            >
              \u25B8
            </span>
            <span
              style={{
                fontSize: 14,
                fontWeight: 800,
                color: t.colorLight,
                letterSpacing: '0.5px',
              }}
            >
              arenafi.org/quiz
            </span>
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
