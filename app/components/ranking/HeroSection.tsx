'use client'

import React, { useState } from 'react'
import Link from 'next/link'
import { t } from '@/lib/i18n'
import { TraderAvatar } from './shared/TraderDisplay'
import { formatROI, formatDisplayName } from './utils'
import type { Trader } from './RankingTable'
import { tokens } from '@/lib/design-tokens'

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        navigator.clipboard.writeText(text).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        })
      }}
      aria-label={copied ? 'Copied' : 'Copy trader ID'}
      title={t('copy')}
      style={{
        background: 'none', border: 'none', cursor: 'pointer',
        padding: 2, display: 'inline-flex', alignItems: 'center',
        opacity: 0.6, color: copied ? tokens.colors.accent.success : 'inherit',
      }}
    >
      {copied ? (
        <svg width={10} height={10} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
          <path d="M20 6L9 17l-5-5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : (
        <svg width={10} height={10} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
          <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
        </svg>
      )}
    </button>
  )
}

const MEDAL_COLORS = [tokens.colors.medal.gold, tokens.colors.medal.silver, tokens.colors.medal.bronze]

function TopTraderCard({ trader, rank }: { trader: Trader; rank: number }) {
  const handle = trader.handle || trader.id
  const displayName = trader.display_name || formatDisplayName(trader.handle || trader.id, trader.source)
  const isAddress = handle.startsWith('0x') && handle.length > 20
  const roi = trader.roi ?? 0
  const roiColor = roi >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error
  const href = `/trader/${encodeURIComponent(trader.id)}${trader.source ? `?platform=${encodeURIComponent(trader.source)}` : ""}`
  const medalColor = MEDAL_COLORS[rank - 1] || tokens.colors.text.tertiary

  return (
    <Link href={href} style={{ textDecoration: 'none', flex: 1, minWidth: 0 }}>
      <div
        className="hero-top3-card"
        style={{
          borderRadius: tokens.radius.lg,
          border: `1.5px solid ${medalColor}`,
          background: tokens.colors.bg.secondary,
          padding: `${tokens.spacing[3]} ${tokens.spacing[3]}`,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 6,
          transition: `transform ${tokens.transition.fast}`,
          overflow: 'hidden',
        }}
      >
        {/* Rank + Avatar row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 12, fontWeight: 800, color: medalColor }}>{rank}</span>
          <TraderAvatar
            traderId={trader.id}
            displayName={displayName}
            avatarUrl={trader.avatar_url}
            rank={rank}
            size={32}
          />
        </div>

        {/* Name */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 2, maxWidth: '100%', minWidth: 0 }}>
          <span className="hero-card-name" style={{
            fontSize: 12, fontWeight: 700,
            color: tokens.colors.text.primary,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            maxWidth: 140,
          }}>
            {displayName}
          </span>
          {isAddress && <CopyButton text={handle} />}
        </div>

        {/* ROI */}
        <span className="hero-card-roi" style={{ fontSize: 16, fontWeight: 900, color: roiColor, lineHeight: 1 }}>
          {formatROI(roi)}
        </span>
      </div>
    </Link>
  )
}

export default function HeroSection({ traders }: { traders: Trader[] }) {
  if (!traders || traders.length < 3) return null

  const top3 = traders.slice(0, 3)

  return (
    <>
      <style>{`
        .hero-top3-grid {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 8px;
          margin-bottom: 8px;
        }
        @media (max-width: 639px) {
          .hero-top3-grid {
            grid-template-columns: 1fr;
          }
        }
      `}</style>
      <div className="hero-top3-grid">
        {top3.map((trader, i) => (
          <TopTraderCard key={trader.id} trader={trader} rank={i + 1} />
        ))}
      </div>
    </>
  )
}

export { CopyButton }
