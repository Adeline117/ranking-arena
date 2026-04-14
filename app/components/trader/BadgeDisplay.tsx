'use client'

/**
 * BadgeDisplay
 *
 * Shows earned badges for a trader with tooltips and links.
 */

import { useState, useEffect, type ReactNode } from 'react'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { tokens } from '@/lib/design-tokens'
import type { EarnedBadge } from '@/lib/badges'
import { apiFetch } from '@/lib/utils/api-fetch'

interface BadgeDisplayProps {
  traderHandle: string
  size?: 'sm' | 'md' | 'lg'
  maxDisplay?: number
  showLabels?: boolean
}

const SIZE_CONFIG = {
  sm: { icon: 16, text: 'text-[10px]', gap: 'gap-1', badge: 'px-1.5 py-0.5' },
  md: { icon: 20, text: 'text-xs', gap: 'gap-1.5', badge: 'px-2 py-1' },
  lg: { icon: 24, text: 'text-sm', gap: 'gap-2', badge: 'px-2.5 py-1.5' },
} as const

const BADGE_ICONS: Record<string, ReactNode> = {
  trophy: (
    <path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6m12 5h1.5a2.5 2.5 0 0 0 0-5H18M9 18h6m-3 0v-4m0 0a5 5 0 0 1-5-5V4h10v5a5 5 0 0 1-5 5z" />
  ),
  medal: (
    <>
      <circle cx="12" cy="8" r="6" />
      <path d="M15.477 12.89L17 22l-5-3-5 3 1.523-9.11" />
    </>
  ),
  award: (
    <>
      <circle cx="12" cy="8" r="6" />
      <path d="M9 16l-2 6 5-3 5 3-2-6" />
    </>
  ),
  'shield-check': (
    <>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <path d="M9 12l2 2 4-4" />
    </>
  ),
  target: (
    <>
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="12" r="6" />
      <circle cx="12" cy="12" r="2" />
    </>
  ),
  'trending-up': (
    <path d="M23 6l-9.5 9.5-5-5L1 18m22-12h-6m6 0v6" />
  ),
  shield: (
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
  ),
  rocket: (
    <>
      <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" />
      <path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" />
      <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0" />
      <path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" />
    </>
  ),
  anchor: (
    <>
      <circle cx="12" cy="5" r="3" />
      <line x1="12" y1="22" x2="12" y2="8" />
      <path d="M5 12H2a10 10 0 0 0 20 0h-3" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v6l4 2" />
    </>
  ),
  star: (
    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
  ),
  hexagon: (
    <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
  ),
}

const RARITY_GLOW: Record<string, string> = {
  legendary: 'shadow-[0_0_12px_var(--color-gold-glow)]',
  epic: 'shadow-[0_0_10px_var(--color-accent-primary-40)]',
  rare: 'shadow-[0_0_8px_var(--color-accent-primary-30)]',
  common: '',
}

export function BadgeDisplay({
  traderHandle,
  size = 'md',
  maxDisplay = 5,
  showLabels = false,
}: BadgeDisplayProps) {
  const { language } = useLanguage()
  const [badges, setBadges] = useState<EarnedBadge[]>([])
  const [loading, setLoading] = useState(true)
  const [hoveredBadge, setHoveredBadge] = useState<string | null>(null)

  useEffect(() => {
    let alive = true

    async function fetchBadges() {
      try {
        const data = await apiFetch<{ badges?: EarnedBadge[] }>(`/api/traders/${encodeURIComponent(traderHandle)}/badges`)
        if (!alive) return
        setBadges(data.badges || [])
      } catch {
        // Failed to fetch badges
      } finally {
        if (alive) setLoading(false)
      }
    }

    fetchBadges()
    return () => { alive = false }
  }, [traderHandle])

  if (loading || badges.length === 0) return null

  const s = SIZE_CONFIG[size]
  const displayBadges = badges.slice(0, maxDisplay)
  const remaining = badges.length - maxDisplay

  return (
    <div className={`flex flex-wrap items-center ${s.gap}`}>
      {displayBadges.map((badge) => (
        <div
          key={badge.id}
          className="relative"
          onMouseEnter={() => setHoveredBadge(badge.id)}
          onMouseLeave={() => setHoveredBadge(null)}
        >
          <div
            className={`
              inline-flex items-center ${s.gap} ${s.badge} rounded-md
              border transition-all duration-200
              ${RARITY_GLOW[badge.rarity]}
            `}
            style={{
              backgroundColor: `${badge.color}15`,
              borderColor: `${badge.color}40`,
            }}
          >
            <svg
              width={s.icon}
              height={s.icon}
              viewBox="0 0 24 24"
              fill="none"
              stroke={badge.color}
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              {BADGE_ICONS[badge.icon] || BADGE_ICONS.award}
            </svg>

            {showLabels && (
              <span
                className={`${s.text} font-semibold whitespace-nowrap`}
                style={{ color: badge.color }}
              >
                {badge.name[language as 'en' | 'zh'] || badge.name.en}
              </span>
            )}
          </div>

          {/* Tooltip */}
          {hoveredBadge === badge.id && (
            <div
              className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-3 py-2
                         text-xs whitespace-nowrap z-50"
              style={{
                background: tokens.glass.bg.heavy,
                backdropFilter: tokens.glass.blur.lg,
                WebkitBackdropFilter: tokens.glass.blur.lg,
                border: tokens.glass.border.medium,
                borderRadius: tokens.radius.md,
                boxShadow: tokens.shadow.lg,
              }}
            >
              <div className="font-semibold mb-0.5" style={{ color: badge.color }}>
                {badge.name[language as 'en' | 'zh'] || badge.name.en}
              </div>
              <div style={{ color: "var(--color-text-secondary)" }}>
                {badge.description[language as 'en' | 'zh'] || badge.description.en}
              </div>
              <div className="text-[10px] mt-1 capitalize" style={{ color: "var(--color-text-tertiary)" }}>
                {badge.rarity}
              </div>
            </div>
          )}
        </div>
      ))}

      {remaining > 0 && (
        <span className={`${s.text}`} style={{ color: 'var(--color-text-tertiary)' }}>+{remaining}</span>
      )}
    </div>
  )
}
