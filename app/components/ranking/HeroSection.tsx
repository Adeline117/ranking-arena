'use client'

import React, { useState } from 'react'
import Link from 'next/link'
import { TraderAvatar } from './shared/TraderDisplay'
import { formatROI, formatDisplayName } from './utils'
import { EXCHANGE_NAMES } from '@/lib/constants/exchanges'
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
      title="复制地址"
      style={{
        background: 'none',
        border: 'none',
        cursor: 'pointer',
        padding: 2,
        display: 'inline-flex',
        alignItems: 'center',
        opacity: 0.6,
        transition: 'opacity 0.2s',
        color: copied ? tokens.colors.accent.success : 'inherit',
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

// Medal border gradients - these reference theme tokens at render time
function getMedalBorders() {
  const m = tokens.colors.medal
  return [
    `linear-gradient(135deg, ${m.gold}, ${m.goldEnd}, ${m.gold})`,
    `linear-gradient(135deg, ${m.silver}, #E8E8E8, ${m.silver})`,
    `linear-gradient(135deg, ${m.bronze}, #D4A574, ${m.bronze})`,
  ]
}

const MEDAL_LABELS = ['#1', '#2', '#3']

function HeroCard({ trader, rank, large }: { trader: Trader; rank: number; large?: boolean }) {
  const handle = trader.handle || trader.id
  const displayName = formatDisplayName(handle, trader.source)
  const isAddress = handle.startsWith('0x') && handle.length > 20
  const roi = trader.roi || 0
  const roiColor = roi >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error
  const exchangeName = EXCHANGE_NAMES[trader.source || ''] || (trader.source || '').split('_')[0]
  const href = `/trader/${encodeURIComponent(handle)}`

  const borderGradient = getMedalBorders()[rank - 1] || 'none'

  return (
    <Link href={href} style={{ textDecoration: 'none', display: 'block', flex: large ? '1 1 0' : undefined, minWidth: large ? 0 : undefined }}>
      <div
        style={{
          position: 'relative',
          borderRadius: 16,
          padding: 2,
          background: borderGradient,
          transition: 'transform 0.2s, box-shadow 0.2s',
        }}
        className="hero-card-outer"
      >
        <div
          style={{
            borderRadius: 14,
            background: 'linear-gradient(180deg, rgba(20,20,35,0.95) 0%, rgba(15,15,28,0.98) 100%)',
            padding: large ? '20px 16px' : '12px 10px',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: large ? 10 : 6,
            minHeight: large ? 160 : 'auto',
            justifyContent: 'center',
          }}
        >
          {/* Rank label */}
          <span style={{
            fontSize: large ? 13 : 11,
            fontWeight: 800,
            color: rank === 1 ? tokens.colors.medal.gold : rank === 2 ? tokens.colors.medal.silver : tokens.colors.medal.bronze,
            letterSpacing: 1,
          }}>
            {MEDAL_LABELS[rank - 1] || `#${rank}`}
          </span>

          {/* Avatar */}
          <TraderAvatar
            traderId={trader.id}
            displayName={!hasRealHandle(trader) ? `#${rank}` : displayName}
            avatarUrl={trader.avatar_url}
            rank={rank}
            size={large ? 48 : 32}
          />

          {/* Name */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 3, maxWidth: '100%' }}>
            <span style={{
              fontSize: large ? 14 : 11,
              fontWeight: 700,
              color: tokens.colors.white,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              maxWidth: large ? 140 : 80,
            }}>
              {displayName}
            </span>
            {isAddress && <CopyButton text={handle} />}
          </div>

          {/* ROI */}
          <span style={{
            fontSize: large ? 22 : 15,
            fontWeight: 900,
            color: roiColor,
            lineHeight: 1.1,
          }}>
            {formatROI(roi)}
          </span>

          {/* Exchange */}
          <span style={{
            fontSize: 10,
            color: tokens.colors.text.tertiary,
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: 0.5,
          }}>
            {exchangeName}
          </span>
        </div>
      </div>
    </Link>
  )
}

/** Check if a trader has a real (non-numeric) handle */
function hasRealHandle(t: Trader): boolean {
  const h = t.handle || t.id
  return !(/^\d{8,}$/.test(h))
}

export default function HeroSection({ traders }: { traders: Trader[] }) {
  if (!traders || traders.length < 3) return null

  // Prioritize traders with real handles for hero display
  const withHandle = traders.filter(hasRealHandle)
  const withoutHandle = traders.filter(t => !hasRealHandle(t))
  const prioritized = [...withHandle, ...withoutHandle].slice(0, 10)

  const top3 = prioritized.slice(0, 3)
  const top4to10 = prioritized.slice(3, 10)

  return (
    <div style={{
      background: 'linear-gradient(180deg, rgba(10,10,25,0.9) 0%, rgba(15,15,30,0.7) 100%)',
      borderRadius: 20,
      padding: '24px 16px 20px',
      marginBottom: 12,
    }}>
      <style>{`
        .hero-card-outer:hover {
          transform: translateY(-3px);
          box-shadow: 0 8px 24px rgba(0,0,0,0.4);
        }
      `}</style>

      {/* Top 3 */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(3, 1fr)',
        gap: 12,
        marginBottom: top4to10.length > 0 ? 16 : 0,
      }}>
        {top3.map((trader, i) => (
          <HeroCard key={trader.id} trader={trader} rank={i + 1} large />
        ))}
      </div>

      {/* Top 4-10 */}
      {top4to10.length > 0 && (
        <div style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${Math.min(top4to10.length, 7)}, 1fr)`,
          gap: 8,
        }}>
          {top4to10.map((trader, i) => (
            <HeroCard key={trader.id} trader={trader} rank={i + 4} />
          ))}
        </div>
      )}
    </div>
  )
}

export { CopyButton }
