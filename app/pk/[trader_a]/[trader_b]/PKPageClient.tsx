'use client'

/**
 * PKPageClient — client-side interactive elements for the PK comparison page.
 * Handles PNG download and Twitter/X share actions.
 */

import { useState } from 'react'

interface PKPageClientProps {
  handleA: string
  handleB: string
  platform: string
  window: string
  nameA: string
  nameB: string
  /** pre-built canonical URL of the PK page */
  pkUrl: string
}

export default function PKPageClient({
  handleA,
  handleB,
  platform,
  window: timeWindow,
  nameA,
  nameB,
  pkUrl,
}: PKPageClientProps) {
  const [downloading, setDownloading] = useState(false)

  // Build OG image URL for download
  const ogUrl = `/api/og/pk?a=${encodeURIComponent(handleA)}&b=${encodeURIComponent(handleB)}${
    platform ? `&platform=${encodeURIComponent(platform)}` : ''
  }${timeWindow ? `&window=${encodeURIComponent(timeWindow)}` : ''}`

  const handleDownload = async () => {
    if (downloading) return
    setDownloading(true)
    try {
      const res = await fetch(ogUrl)
      if (!res.ok) throw new Error('Image fetch failed')
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `arena-pk-${handleA}-vs-${handleB}.png`
      document.body.appendChild(anchor)
      anchor.click()
      document.body.removeChild(anchor)
      URL.revokeObjectURL(url)
    } catch {
      // silently fail — browser may block or image may error
    } finally {
      setDownloading(false)
    }
  }

  const handleShareX = () => {
    const text = `${nameA} vs ${nameB} — who is the better trader? Check the PK on Arena:`
    const shareUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(pkUrl)}`
    window.open(shareUrl, '_blank', 'noopener,noreferrer,width=600,height=450')
  }

  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(pkUrl)
    } catch {
      // fallback: no-op
    }
  }

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        flexWrap: 'wrap',
        justifyContent: 'center',
      }}
    >
      {/* Share to X */}
      <button
        onClick={handleShareX}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '10px 20px',
          borderRadius: 10,
          background: 'rgba(255,255,255,0.05)',
          border: '1px solid rgba(255,255,255,0.15)',
          color: '#EDEDED',
          fontSize: 14,
          fontWeight: 600,
          cursor: 'pointer',
          transition: 'all 0.2s ease',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = 'rgba(255,255,255,0.1)'
          e.currentTarget.style.borderColor = 'rgba(255,255,255,0.3)'
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'rgba(255,255,255,0.05)'
          e.currentTarget.style.borderColor = 'rgba(255,255,255,0.15)'
        }}
      >
        {/* X (Twitter) icon */}
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="currentColor"
        >
          <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.746l7.73-8.835L1.254 2.25H8.08l4.258 5.622 5.907-5.622zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
        </svg>
        Share on X
      </button>

      {/* Download PNG */}
      <button
        onClick={handleDownload}
        disabled={downloading}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '10px 20px',
          borderRadius: 10,
          background: 'rgba(139,111,168,0.12)',
          border: '1px solid rgba(139,111,168,0.35)',
          color: '#c9b8db',
          fontSize: 14,
          fontWeight: 600,
          cursor: downloading ? 'not-allowed' : 'pointer',
          opacity: downloading ? 0.6 : 1,
          transition: 'all 0.2s ease',
        }}
        onMouseEnter={(e) => {
          if (!downloading) {
            e.currentTarget.style.background = 'rgba(139,111,168,0.22)'
          }
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'rgba(139,111,168,0.12)'
        }}
      >
        {/* Download icon */}
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="7 10 12 15 17 10" />
          <line x1="12" y1="15" x2="12" y2="3" />
        </svg>
        {downloading ? 'Downloading...' : 'Download PNG'}
      </button>

      {/* Copy link */}
      <button
        onClick={handleCopyLink}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '10px 20px',
          borderRadius: 10,
          background: 'rgba(255,255,255,0.03)',
          border: '1px solid rgba(255,255,255,0.1)',
          color: '#888888',
          fontSize: 14,
          fontWeight: 600,
          cursor: 'pointer',
          transition: 'all 0.2s ease',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = 'rgba(255,255,255,0.07)'
          e.currentTarget.style.color = '#EDEDED'
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'rgba(255,255,255,0.03)'
          e.currentTarget.style.color = '#888888'
        }}
      >
        {/* Link icon */}
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
          <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
        </svg>
        Copy Link
      </button>
    </div>
  )
}
