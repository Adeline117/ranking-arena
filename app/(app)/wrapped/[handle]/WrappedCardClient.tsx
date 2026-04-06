"use client"

/**
 * WrappedCardClient -- interactive rank card
 *
 * Renders the visual card in-browser matching the OG image style.
 * Provides download PNG, share on X, and view full profile actions.
 */

import { useState, useCallback } from 'react'
import { tokens } from '@/lib/design-tokens'
import type { WrappedTraderData } from './page'

// Brand colors (synced with /api/og/rank/route.tsx)
const C = {
  bgTop: '#0A0A0F',
  bgBottom: '#1A1A2E',
  purple: '#8B5CF6',
  purpleLight: '#A78BFA',
  purpleDim: 'rgba(139,92,246,0.18)',
  gold: '#D4AF37',
  goldLight: '#F0D060',
  goldDim: 'rgba(212,175,55,0.15)',
  white: '#FFFFFF',
  offWhite: '#EDEDED',
  dim: 'rgba(255,255,255,0.50)',
  dimmer: 'rgba(255,255,255,0.28)',
  success: '#2FE57D',
  error: '#FF5555',
  border: 'rgba(139,92,246,0.25)',
  borderGold: 'rgba(212,175,55,0.35)',
}

function formatRoi(roi: number): string {
  const abs = Math.abs(roi)
  const sign = roi >= 0 ? '+' : '-'
  if (abs >= 10000) return `${sign}${Math.round(abs / 1000)}K%`
  if (abs >= 1000) return `${sign}${(abs / 1000).toFixed(1)}K%`
  return `${sign}${abs.toFixed(1)}%`
}

function getTopPercent(rank: number, total: number): string {
  if (!total || !rank || rank <= 0) return ''
  const pct = rank / total
  if (pct <= 0.001) return 'Top 0.1%'
  if (pct <= 0.01) return 'Top 1%'
  if (pct <= 0.03) return 'Top 3%'
  if (pct <= 0.05) return 'Top 5%'
  if (pct <= 0.10) return 'Top 10%'
  if (pct <= 0.25) return 'Top 25%'
  return `Top ${Math.ceil(pct * 100)}%`
}

function formatWindow(w: string): string {
  const map: Record<string, string> = { '7D': '7 Day', '30D': '30 Day', '90D': '90 Day' }
  return map[w] ?? w
}

interface Props {
  data: WrappedTraderData
  ogImageUrl: string
}

export default function WrappedCardClient({ data, ogImageUrl }: Props) {
  const [downloading, setDownloading] = useState(false)

  const rank = data.rank
  const total = data.total
  const roi = data.roi
  const winRate = data.winRate
  const score = data.score

  const roiValid = roi != null
  const roiColor = roiValid && roi >= 0 ? C.success : C.error
  const roiStr = roiValid ? formatRoi(roi) : '--'
  const topPct = rank && total ? getTopPercent(rank, total) : ''
  const rankDisplay = rank ? (rank <= 9999 ? `${rank}` : `${Math.round(rank / 1000)}K`) : '--'
  const totalDisplay = total ? `${total.toLocaleString('en-US')}+` : '32,000+'
  const windowLabel = formatWindow(data.window)

  // Build X share text and link
  const shareUrl = typeof window !== 'undefined'
    ? `${window.location.origin}/wrapped/${encodeURIComponent(data.handle)}${data.platform ? '?platform=' + data.platform : ''}`
    : `https://www.arenafi.org/wrapped/${encodeURIComponent(data.handle)}`

  const shareText = [
    `My Arena rank: ${rankDisplay} on ${data.platformLabel}`,
    roiValid ? `${roi >= 0 ? '+' : ''}${roi.toFixed(1)}% ROI in ${windowLabel}` : null,
    topPct ? `${topPct} Trader` : null,
    '',
    shareUrl,
    '',
    '#CryptoTrading #Arena',
  ].filter(v => v !== null).join('\n')

  const xShareUrl = `https://x.com/intent/post?text=${encodeURIComponent(shareText)}`

  const handleDownload = useCallback(async () => {
    setDownloading(true)
    try {
      const res = await fetch(ogImageUrl)
      if (!res.ok) throw new Error('Failed to fetch image')
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `arena-rank-${data.handle}.png`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch {
      // Fallback: open in new tab
      window.open(ogImageUrl, '_blank')
    } finally {
      setDownloading(false)
    }
  }, [ogImageUrl, data.handle])

  const handleNativeShare = useCallback(async () => {
    if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
      try {
        // On mobile, try to share the OG image as a file
        const res = await fetch(ogImageUrl)
        const blob = await res.blob()
        const file = new File([blob], 'arena-rank-' + data.handle + '.png', { type: 'image/png' })

        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          await navigator.share({
            title: 'Arena Rank Card',
            text: shareText,
            files: [file],
          })
        } else {
          await navigator.share({
            title: 'Arena Rank Card',
            text: shareText,
            url: shareUrl,
          })
        }
      } catch {
        // User cancelled or share failed, fall back to X share
        window.open(xShareUrl, '_blank', 'noopener,noreferrer,width=600,height=500')
      }
    }
  }, [ogImageUrl, data.handle, shareText, shareUrl, xShareUrl])

  // Detect if navigator.share is available (mobile)
  const hasNativeShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function' && /Mobi|Android/i.test(navigator.userAgent)

  return (
    <div style={{
      minHeight: '100vh',
      background: 'linear-gradient(180deg, #0A0A0F 0%, #1A1A2E 100%)',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '40px 20px',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
    }}>
      {/* Card container */}
      <div style={{
        width: '100%',
        maxWidth: 680,
        display: 'flex',
        flexDirection: 'column',
        gap: 32,
      }}>
        {/* Page title */}
        <div style={{ textAlign: 'center' }}>
          <div style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            padding: '6px 18px',
            borderRadius: 999,
            background: C.goldDim,
            border: `1px solid ${C.borderGold}`,
            marginBottom: 16,
          }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: C.goldLight, letterSpacing: '2px' }}>
              ARENA RANK CARD
            </span>
          </div>
          <h1 style={{
            margin: 0,
            fontSize: 28,
            fontWeight: 900,
            color: C.white,
            letterSpacing: '-0.5px',
          }}>
            {data.displayName}
          </h1>
          <p style={{
            margin: '8px 0 0',
            fontSize: 15,
            color: C.dim,
          }}>
            {data.platformLabel} &middot; {windowLabel} Performance
          </p>
        </div>

        {/* Main visual card */}
        <div style={{
          background: 'linear-gradient(180deg, #0E0A1A 0%, #12121F 100%)',
          borderRadius: 24,
          border: `1px solid ${C.border}`,
          overflow: 'hidden',
          boxShadow: '0 32px 80px rgba(139,92,246,0.15), 0 8px 24px rgba(0,0,0,0.6)',
          position: 'relative',
        }}>
          {/* Top accent bar */}
          <div style={{
            height: 3,
            background: 'linear-gradient(90deg, #8B5CF6 0%, #D4AF37 50%, #8B5CF6 100%)',
          }} />

          {/* Card body */}
          <div style={{ padding: '36px 36px 28px' }}>
            {/* Data cards row */}
            <div style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: 14,
              marginBottom: 20,
            }}>
              {/* Arena Score */}
              <div style={{
                padding: '20px 24px',
                background: C.goldDim,
                borderRadius: 16,
                border: `1px solid ${C.borderGold}`,
              }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: C.goldLight, letterSpacing: '2px', marginBottom: 8 }}>
                  ARENA SCORE
                </div>
                <div style={{ fontSize: 44, fontWeight: 900, color: C.goldLight, letterSpacing: '-1px', lineHeight: 1 }}>
                  {score != null ? Math.round(score).toLocaleString('en-US') : '--'}
                </div>
              </div>

              {/* ROI */}
              <div style={{
                padding: '20px 24px',
                background: roiValid && roi >= 0 ? 'rgba(47,229,125,0.07)' : 'rgba(255,85,85,0.07)',
                borderRadius: 16,
                border: roiValid && roi >= 0 ? '1px solid rgba(47,229,125,0.20)' : '1px solid rgba(255,85,85,0.20)',
              }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: C.dimmer, letterSpacing: '2px', marginBottom: 8 }}>
                  ROI
                </div>
                <div style={{ fontSize: 44, fontWeight: 900, color: roiColor, letterSpacing: '-1px', lineHeight: 1 }}>
                  {roiStr}
                </div>
              </div>
            </div>

            {/* Win Rate row */}
            <div style={{
              display: 'flex',
              gap: 14,
              marginBottom: 24,
            }}>
              <div style={{
                flex: 1,
                padding: '16px 24px',
                background: 'rgba(255,255,255,0.04)',
                borderRadius: 12,
                border: '1px solid rgba(255,255,255,0.08)',
              }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: C.dim, letterSpacing: '2px', marginBottom: 6 }}>
                  WIN RATE
                </div>
                <div style={{ fontSize: 28, fontWeight: 900, color: C.offWhite, letterSpacing: '-1px', lineHeight: 1 }}>
                  {winRate != null ? `${winRate.toFixed(0)}%` : '--'}
                </div>
              </div>
            </div>

            {/* Rank section */}
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '16px 20px',
              background: C.purpleDim,
              borderRadius: 12,
              border: `1px solid ${C.border}`,
              marginBottom: 24,
            }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: C.dimmer, letterSpacing: '1px' }}>
                  RANKED
                </span>
                <span style={{ fontSize: 32, fontWeight: 900, color: C.white, letterSpacing: '-1px' }}>
                  {rankDisplay}
                </span>
                <span style={{ fontSize: 14, color: C.dim }}>
                  / {totalDisplay} traders
                </span>
              </div>
              {topPct && (
                <div style={{
                  padding: '4px 14px',
                  borderRadius: 999,
                  background: C.goldDim,
                  border: `1px solid ${C.borderGold}`,
                }}>
                  <span style={{ fontSize: 13, fontWeight: 800, color: C.goldLight }}>
                    {topPct}
                  </span>
                </div>
              )}
            </div>

            {/* Footer */}
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              paddingTop: 20,
              borderTop: '1px solid rgba(255,255,255,0.06)',
            }}>
              <div style={{ display: 'flex', gap: 8 }}>
                <span style={{
                  padding: '4px 14px',
                  borderRadius: 6,
                  background: C.purpleDim,
                  border: `1px solid ${C.border}`,
                  fontSize: 12,
                  fontWeight: 700,
                  color: C.purpleLight,
                }}>
                  {data.platformLabel}
                </span>
                <span style={{
                  padding: '4px 14px',
                  borderRadius: 6,
                  background: 'rgba(255,255,255,0.05)',
                  border: '1px solid rgba(255,255,255,0.10)',
                  fontSize: 12,
                  fontWeight: 700,
                  color: C.dim,
                }}>
                  {windowLabel}
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <div style={{
                  width: 6, height: 6, borderRadius: 999, background: C.gold,
                }} />
                <span style={{ fontSize: 14, fontWeight: 800, color: C.gold, letterSpacing: '0.5px' }}>
                  arenafi.org
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Action buttons */}
        <div style={{
          display: 'flex',
          gap: 12,
          justifyContent: 'center',
          flexWrap: 'wrap',
        }}>
          {/* Native share (mobile) */}
          {hasNativeShare && (
            <button
              onClick={handleNativeShare}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 10,
                padding: '14px 28px',
                borderRadius: 12,
                background: 'linear-gradient(135deg, #8B5CF6 0%, #D4AF37 100%)',
                border: 'none',
                color: '#FFFFFF',
                fontSize: 15,
                fontWeight: 700,
                cursor: 'pointer',
              }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="18" cy="5" r="3" />
                <circle cx="6" cy="12" r="3" />
                <circle cx="18" cy="19" r="3" />
                <path d="M8.59 13.51l6.83 3.98M15.41 6.51l-6.82 3.98" />
              </svg>
              Share
            </button>
          )}

          {/* Share on X */}
          <a
            href={xShareUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 10,
              padding: '14px 28px',
              borderRadius: 12,
              background: '#000000',
              border: '1px solid rgba(255,255,255,0.15)',
              color: C.white,
              fontSize: 15,
              fontWeight: 700,
              textDecoration: 'none',
              transition: `all ${tokens.transition.base}`,
              cursor: 'pointer',
            }}
          >
            <XIcon />
            Share on X
          </a>

          {/* Download PNG - prominent */}
          <button
            onClick={handleDownload}
            disabled={downloading}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 10,
              padding: '14px 28px',
              borderRadius: 12,
              background: C.purpleDim,
              border: `1px solid ${C.border}`,
              color: C.purpleLight,
              fontSize: 15,
              fontWeight: 700,
              cursor: downloading ? 'wait' : 'pointer',
              transition: `all ${tokens.transition.base}`,
              opacity: downloading ? 0.7 : 1,
            }}
          >
            <DownloadIcon />
            {downloading ? 'Downloading...' : 'Download PNG'}
          </button>

          {/* View full profile */}
          <a
            href={`/trader/${encodeURIComponent(data.handle)}`}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              padding: '14px 24px',
              borderRadius: 12,
              background: 'rgba(255,255,255,0.05)',
              border: '1px solid rgba(255,255,255,0.10)',
              color: C.dim,
              fontSize: 15,
              fontWeight: 600,
              textDecoration: 'none',
              cursor: 'pointer',
            }}
          >
            View Full Profile
          </a>
        </div>

        {/* Preview note */}
        <p style={{
          textAlign: 'center',
          fontSize: 13,
          color: C.dimmer,
          margin: 0,
        }}>
          The card above matches what appears when shared on X
        </p>
      </div>

      {/* Responsive styles for mobile */}
      <style dangerouslySetInnerHTML={{ __html: `
        @media (max-width: 480px) {
          .wrapped-card-grid { grid-template-columns: 1fr !important; }
        }
      ` }} />
    </div>
  )
}

function XIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 1200 1227" fill="currentColor">
      <path d="M714.163 519.284L1160.89 0H1055.03L667.137 450.887L357.328 0H0L468.492 681.821L0 1226.37H105.866L515.491 750.218L842.672 1226.37H1200L714.137 519.284H714.163ZM569.165 687.828L521.697 619.934L144.011 79.6944H306.615L611.412 515.685L658.88 583.579L1055.08 1150.3H892.476L569.165 687.854V687.828Z" />
    </svg>
  )
}

function DownloadIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  )
}
