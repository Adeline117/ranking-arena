import { ImageResponse } from 'next/og'
import { NextRequest } from 'next/server'
import { BASE_URL } from '@/lib/constants/urls'

export const runtime = 'edge'

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl
  const type = searchParams.get('type') || 'default'
  const title = searchParams.get('title') || 'Arena'
  const subtitle = searchParams.get('subtitle') || ''
  const stat1Label = searchParams.get('s1l') || ''
  const stat1Value = searchParams.get('s1v') || ''
  const stat2Label = searchParams.get('s2l') || ''
  const stat2Value = searchParams.get('s2v') || ''
  const stat3Label = searchParams.get('s3l') || ''
  const stat3Value = searchParams.get('s3v') || ''
  const avatarUrlParam = searchParams.get('avatar') || ''

  const stats = [
    stat1Label && { label: stat1Label, value: stat1Value },
    stat2Label && { label: stat2Label, value: stat2Value },
    stat3Label && { label: stat3Label, value: stat3Value },
  ].filter(Boolean) as Array<{ label: string; value: string }>

  // Pre-fetch avatar as base64 so Satori doesn't try to load it directly
  let avatarUrl = ''
  if (avatarUrlParam) {
    if (avatarUrlParam.startsWith('data:')) {
      avatarUrl = avatarUrlParam
    } else {
      try {
        const proxyUrl = `${BASE_URL}/api/avatar?url=${encodeURIComponent(avatarUrlParam)}`
        const res = await fetch(proxyUrl, { signal: AbortSignal.timeout(4000) })
        if (res.ok) {
          const ct = res.headers.get('content-type') || 'image/png'
          if (ct.startsWith('image/')) {
            const buf = await res.arrayBuffer()
            avatarUrl = `data:${ct};base64,${Buffer.from(buf).toString('base64')}`
          }
        }
      } catch {
        // Avatar unavailable — omit it
        avatarUrl = ''
      }
    }
  }

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          background: 'linear-gradient(135deg, #0f0f1a 0%, #1a1a2e 50%, #16213e 100%)',
          fontFamily: 'sans-serif',
          color: '#fff',
          padding: 0,
        }}
      >
        {/* Top accent bar */}
        <div style={{
          height: 6,
          background: 'linear-gradient(90deg, #8b6fa8, #6366f1, #8b6fa8)',
          display: 'flex',
        }} />

        {/* Content */}
        <div style={{
          flex: 1, display: 'flex', flexDirection: 'column',
          justifyContent: 'center', padding: '48px 56px',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 20, marginBottom: 16 }}>
            {avatarUrl && (
              <img
                src={avatarUrl.startsWith('data:') ? avatarUrl : `${BASE_URL}/api/avatar?url=${encodeURIComponent(avatarUrl)}`}
                alt=""
                width={80}
                height={80}
                style={{ borderRadius: '50%', border: '3px solid rgba(139,111,168,0.5)' }}
              />
            )}
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <div style={{
                fontSize: type === 'trader' ? 44 : 40,
                fontWeight: 800,
                lineHeight: 1.15,
                letterSpacing: '-0.02em',
              }}>
                {title}
              </div>
              {subtitle && (
                <div style={{
                  fontSize: 22,
                  color: 'rgba(255,255,255,0.65)',
                  marginTop: 4,
                }}>
                  {subtitle}
                </div>
              )}
            </div>
          </div>

          {/* Stats row */}
          {stats.length > 0 && (
            <div style={{
              display: 'flex', gap: 40, marginTop: 24,
              padding: '20px 0', borderTop: '1px solid rgba(255,255,255,0.1)',
            }}>
              {stats.map((s, i) => (
                <div key={i} style={{ display: 'flex', flexDirection: 'column' }}>
                  <div style={{ fontSize: 36, fontWeight: 700 }}>{s.value}</div>
                  <div style={{ fontSize: 16, color: 'rgba(255,255,255,0.5)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    {s.label}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: '16px 56px',
          borderTop: '1px solid rgba(255,255,255,0.08)',
        }}>
          <div style={{ fontSize: 20, fontWeight: 700, color: 'rgba(255,255,255,0.7)' }}>
            Arena
          </div>
          <div style={{ fontSize: 14, color: 'rgba(255,255,255,0.35)' }}>
            arenafi.org
          </div>
        </div>
      </div>
    ),
    {
      width: 1200,
      height: 630,
      headers: {
        'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=86400',
      },
    },
  )
}
