/**
 * Dynamic OG Image Generator
 * 
 * 生成带热门交易员的社交预览卡片
 * 用于 Twitter/Telegram/Discord 分享
 */

import { ImageResponse } from 'next/og'
import { NextRequest } from 'next/server'

export const runtime = 'edge'

// 颜色配置
const colors = {
  bg: '#0B0A10',
  bgCard: '#14131A',
  text: '#EDEDED',
  textSecondary: '#9A9A9A',
  brand: '#8b6fa8',
  success: '#4DFF9A',
  error: '#FF4D4D',
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    
    const title = searchParams.get('title') || 'Ranking Arena'
    const subtitle = searchParams.get('subtitle') || 'Crypto Trader Rankings'
    const tradersJson = searchParams.get('traders')
    const traderJson = searchParams.get('trader')
    
    // 解析交易员数据
    let traders: { n: string; r: string; p: string }[] = []
    if (tradersJson) {
      try {
        traders = JSON.parse(tradersJson)
      } catch {
        // ignore
      }
    }
    
    // 解析单个交易员
    let trader: { n: string; r: string; pnl: string; p: string; wr?: string; a?: string } | null = null
    if (traderJson) {
      try {
        trader = JSON.parse(traderJson)
      } catch {
        // ignore
      }
    }

    return new ImageResponse(
      (
        <div
          style={{
            height: '100%',
            width: '100%',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: colors.bg,
            fontFamily: 'Inter, system-ui, sans-serif',
            padding: 60,
          }}
        >
          {/* Logo & Brand */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 16,
              marginBottom: 40,
            }}
          >
            <div
              style={{
                width: 60,
                height: 60,
                borderRadius: 12,
                background: `linear-gradient(135deg, ${colors.brand}, #a88bc7)`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
                <path d="M12 1L9 9H1l6 5-2 9 7-5 7 5-2-9 6-5h-8z"/>
              </svg>
            </div>
            <span
              style={{
                fontSize: 32,
                fontWeight: 700,
                color: colors.text,
              }}
            >
              Ranking Arena
            </span>
          </div>

          {/* Title */}
          <div
            style={{
              fontSize: 56,
              fontWeight: 800,
              color: colors.text,
              textAlign: 'center',
              marginBottom: 16,
            }}
          >
            {title}
          </div>

          {/* Subtitle */}
          <div
            style={{
              fontSize: 24,
              color: colors.textSecondary,
              textAlign: 'center',
              marginBottom: 50,
            }}
          >
            {subtitle}
          </div>

          {/* Single Trader Card */}
          {trader && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 24,
                padding: '24px 40px',
                borderRadius: 16,
                backgroundColor: colors.bgCard,
                border: `2px solid ${colors.brand}40`,
              }}
            >
              {/* Avatar */}
              <div
                style={{
                  width: 80,
                  height: 80,
                  borderRadius: 40,
                  background: trader.a 
                    ? undefined 
                    : `linear-gradient(135deg, ${colors.brand}, #a88bc7)`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 36,
                  color: '#fff',
                  fontWeight: 700,
                  overflow: 'hidden',
                }}
              >
                {trader.a ? (
                   
                  <img src={trader.a} alt="" width={80} height={80} style={{ objectFit: 'cover' }} />
                ) : (
                  trader.n.charAt(0).toUpperCase()
                )}
              </div>

              {/* Info */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ fontSize: 32, fontWeight: 700, color: colors.text }}>
                  {trader.n}
                </div>
                <div style={{ fontSize: 18, color: colors.textSecondary }}>
                  {trader.p}
                </div>
              </div>

              {/* Stats */}
              <div style={{ display: 'flex', gap: 32, marginLeft: 40 }}>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                  <div style={{ 
                    fontSize: 36, 
                    fontWeight: 700, 
                    color: parseFloat(trader.r) >= 0 ? colors.success : colors.error 
                  }}>
                    {parseFloat(trader.r) >= 0 ? '+' : ''}{trader.r}%
                  </div>
                  <div style={{ fontSize: 14, color: colors.textSecondary }}>ROI</div>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                  <div style={{ fontSize: 36, fontWeight: 700, color: colors.text }}>
                    ${parseInt(trader.pnl).toLocaleString()}
                  </div>
                  <div style={{ fontSize: 14, color: colors.textSecondary }}>PnL</div>
                </div>
                {trader.wr && (
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                    <div style={{ fontSize: 36, fontWeight: 700, color: colors.text }}>
                      {trader.wr}%
                    </div>
                    <div style={{ fontSize: 14, color: colors.textSecondary }}>Win Rate</div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Top Traders Grid */}
          {traders.length > 0 && !trader && (
            <div
              style={{
                display: 'flex',
                gap: 24,
              }}
            >
              {traders.slice(0, 3).map((t, i) => (
                <div
                  key={i}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    padding: '24px 32px',
                    borderRadius: 16,
                    backgroundColor: colors.bgCard,
                    border: i === 0 ? `2px solid ${colors.brand}` : `1px solid ${colors.brand}40`,
                    minWidth: 180,
                  }}
                >
                  {/* Rank Badge */}
                  <div
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: '50%',
                      background: i === 0 ? '#FFD700' : i === 1 ? '#C0C0C0' : '#CD7F32',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      marginBottom: 12,
                      fontWeight: 700,
                      fontSize: 14,
                      color: '#000',
                    }}
                  >
                    {i + 1}
                  </div>
                  {/* Name */}
                  <div
                    style={{
                      fontSize: 20,
                      fontWeight: 600,
                      color: colors.text,
                      marginBottom: 4,
                    }}
                  >
                    {t.n.length > 10 ? t.n.slice(0, 10) + '...' : t.n}
                  </div>
                  {/* Platform */}
                  <div
                    style={{
                      fontSize: 14,
                      color: colors.textSecondary,
                      marginBottom: 12,
                    }}
                  >
                    {t.p}
                  </div>
                  {/* ROI */}
                  <div
                    style={{
                      fontSize: 28,
                      fontWeight: 700,
                      color: parseFloat(t.r) >= 0 ? colors.success : colors.error,
                    }}
                  >
                    {parseFloat(t.r) >= 0 ? '+' : ''}{t.r}%
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Footer */}
          <div
            style={{
              position: 'absolute',
              bottom: 30,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              color: colors.textSecondary,
              fontSize: 16,
            }}
          >
            <span>arena.trading</span>
            <span>•</span>
            <span>20+ Exchanges</span>
            <span>•</span>
            <span>Real-time Data</span>
          </div>
        </div>
      ),
      {
        width: 1200,
        height: 630,
        headers: {
          'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=86400',
        },
      }
    )
  } catch (error) {
    console.error('OG Image generation error:', error)
    
    // 返回简单的备用图片
    return new ImageResponse(
      (
        <div
          style={{
            height: '100%',
            width: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 16,
            backgroundColor: '#0B0A10',
            color: '#EDEDED',
            fontSize: 48,
            fontWeight: 700,
          }}
        >
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke={colors.brand} strokeWidth="2">
            <path d="M12 1L9 9H1l6 5-2 9 7-5 7 5-2-9 6-5h-8z"/>
          </svg>
          Ranking Arena
        </div>
      ),
      { width: 1200, height: 630 }
    )
  }
}
