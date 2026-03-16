'use client'

import React, { useState, useCallback, memo } from 'react'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import StarRating from '@/app/components/ui/StarRating'
import { supabase } from '@/lib/supabase/client'
import type { DirectoryItem } from './DirectoryPage'

function InitialAvatar({ name, accentVar }: { name: string; accentVar: string }) {
  return (
    <div style={{
      width: 44, height: 44, borderRadius: tokens.radius.xl, flexShrink: 0,
      background: tokens.gradient.primarySubtle,
      border: '1px solid var(--color-border-primary)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: tokens.typography.fontSize.md, fontWeight: 700, color: accentVar,
    }}>
      {name?.[0] || '?'}
    </div>
  )
}

export const DirectoryCard = memo(function DirectoryCard({
  item, language, categoryLabelMap, pricingLabelKeys, noRatingsKey, accentVar, accentMutedVar, itemType,
}: {
  item: DirectoryItem
  language: string
  categoryLabelMap: Record<string, string>
  pricingLabelKeys?: Record<string, string>
  noRatingsKey?: string
  accentVar: string
  accentMutedVar: string
  /** 'institution' or 'tool' — used for rating API calls */
  itemType?: 'institution' | 'tool'
}) {
  const { t } = useLanguage()
  const name = language === 'zh' ? (item.name_zh || item.name) : item.name
  const desc = language === 'zh' ? (item.description_zh || item.description) : item.description
  const href = item.website || item.github_url || '#'
  const hasLink = !!(item.website || item.github_url)
  const [logoError, setLogoError] = useState(false)

  // Rating state
  const [optimisticRating, setOptimisticRating] = useState<number | null>(null)
  const [optimisticCount, setOptimisticCount] = useState<number | null>(null)
  const [ratingStatus, setRatingStatus] = useState<'idle' | 'submitting' | 'success' | 'login-required'>('idle')

  const displayAvg = optimisticRating ?? item.avg_rating
  const displayCount = optimisticCount ?? item.rating_count

  const handleRate = useCallback(async (rating: number) => {
    if (!itemType) return

    // Check auth
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) {
      setRatingStatus('login-required')
      setTimeout(() => setRatingStatus('idle'), 2500)
      return
    }

    // Optimistic update
    const prevAvg = item.avg_rating ?? 0
    const prevCount = item.rating_count ?? 0
    const newCount = prevCount + 1
    const newAvg = (prevAvg * prevCount + rating) / newCount
    setOptimisticRating(Math.round(newAvg * 100) / 100)
    setOptimisticCount(newCount)
    setRatingStatus('submitting')

    try {
      const res = await fetch(`/api/directory/${item.id}/ratings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ rating, item_type: itemType }),
      })

      if (res.ok) {
        const data = await res.json()
        setOptimisticRating(data.avg_rating)
        setOptimisticCount(data.rating_count)
        setRatingStatus('success')
        setTimeout(() => setRatingStatus('idle'), 2000)
      } else {
        // Revert
        setOptimisticRating(null)
        setOptimisticCount(null)
        setRatingStatus('idle')
      }
    } catch {
      setOptimisticRating(null)
      setOptimisticCount(null)
      setRatingStatus('idle')
    }
  }, [item.id, item.avg_rating, item.rating_count, itemType])

  const pricingLabel = pricingLabelKeys && item.pricing
    ? (pricingLabelKeys[item.pricing] ? t(pricingLabelKeys[item.pricing]) : item.pricing)
    : null

  const visibleTags = item.tags?.slice(0, 3) || []
  const extraTagCount = (item.tags?.length || 0) - 3

  return (
    <a
      href={href}
      target={hasLink ? '_blank' : undefined}
      rel="noopener noreferrer"
      className="directory-card"
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 12 }}>
        {item.logo_url && !logoError ? (
          <img
            src={item.logo_url}
            alt={`${item.name} logo`}
            width={44} height={44}
            loading="lazy"
            style={{
              borderRadius: tokens.radius.xl, objectFit: 'cover', flexShrink: 0,
              border: '1px solid var(--color-border-primary)',
            }}
            onError={() => setLogoError(true)}
          />
        ) : (
          <InitialAvatar name={name} accentVar={accentVar} />
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontSize: tokens.typography.fontSize.base, fontWeight: 700,
            color: 'var(--color-text-primary)', marginBottom: 3,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {name}
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: tokens.typography.fontSize.xs, color: 'var(--color-text-tertiary)', fontWeight: 500 }}>
            <span>{categoryLabelMap[item.category] ? t(categoryLabelMap[item.category]) : item.category}</span>
            {pricingLabel && (
              <span style={{
                padding: '2px 8px', borderRadius: tokens.radius.full,
                background: item.pricing === 'free' || item.pricing === 'open_source'
                  ? 'var(--color-accent-success-12)'
                  : item.pricing === 'paid'
                    ? 'var(--color-accent-warning-12, rgba(255, 184, 0, 0.12))'
                    : 'var(--color-accent-primary-08)',
                color: item.pricing === 'free' || item.pricing === 'open_source'
                  ? 'var(--color-accent-success)'
                  : item.pricing === 'paid'
                    ? 'var(--color-accent-warning, #FFB800)'
                    : 'var(--color-text-secondary)',
                fontSize: tokens.typography.fontSize.xs, fontWeight: 600, lineHeight: '1.4',
              }}>
                {pricingLabel}
              </span>
            )}
          </div>
        </div>
        {/* External link indicator */}
        {hasLink && (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--color-text-tertiary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, opacity: 0.5 }}>
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" />
          </svg>
        )}
      </div>

      {desc && (
        <p style={{
          fontSize: tokens.typography.fontSize.sm, color: 'var(--color-text-secondary)',
          lineHeight: tokens.typography.lineHeight.normal, margin: '0 0 12px',
          overflow: 'hidden', textOverflow: 'ellipsis',
          display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' as const,
        }}>
          {desc}
        </p>
      )}

      {visibleTags.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12, alignItems: 'center' }}>
          {visibleTags.map(tag => (
            <span key={tag} style={{
              fontSize: tokens.typography.fontSize.xs, padding: '3px 10px',
              borderRadius: tokens.radius.full, fontWeight: 500,
              background: 'var(--color-bg-tertiary)', color: 'var(--color-text-secondary)',
              border: '1px solid var(--color-border-primary)',
            }}>
              {tag}
            </span>
          ))}
          {extraTagCount > 0 && (
            <span style={{
              fontSize: tokens.typography.fontSize.xs, padding: '3px 8px',
              color: 'var(--color-text-tertiary)', fontWeight: 500,
            }}>
              +{extraTagCount}
            </span>
          )}
        </div>
      )}

      {/* Interactive rating area */}
      <div
        onClick={(e) => { e.preventDefault(); e.stopPropagation() }}
        style={{ position: 'relative' }}
      >
        {displayAvg != null && displayAvg > 0 ? (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '6px 10px', borderRadius: tokens.radius.lg,
            background: accentMutedVar, border: `1px solid ${accentVar}`,
            width: 'fit-content',
          }}>
            <StarRating
              rating={displayAvg}
              ratingCount={displayCount}
              size={14}
              readonly={!itemType}
              onRate={itemType ? handleRate : undefined}
            />
          </div>
        ) : itemType ? (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '6px 10px', borderRadius: tokens.radius.lg,
            background: accentMutedVar, border: `1px solid ${accentVar}`,
            width: 'fit-content',
          }}>
            <StarRating
              rating={0}
              ratingCount={0}
              size={14}
              readonly={false}
              onRate={handleRate}
            />
          </div>
        ) : noRatingsKey ? (
          <span style={{ fontSize: 12, color: 'var(--color-text-tertiary)', fontStyle: 'italic' }}>
            {t(noRatingsKey)}
          </span>
        ) : null}

        {/* Status toast */}
        {ratingStatus === 'login-required' && (
          <span style={{
            position: 'absolute', bottom: '100%', left: 0, marginBottom: 4,
            fontSize: 11, color: 'var(--color-accent-warning, #FFB800)',
            background: 'var(--color-bg-secondary)', padding: '4px 8px',
            borderRadius: tokens.radius.md, whiteSpace: 'nowrap',
            border: '1px solid var(--color-border-primary)',
            boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
          }}>
            {t('loginToRate')}
          </span>
        )}
        {ratingStatus === 'success' && (
          <span style={{
            position: 'absolute', bottom: '100%', left: 0, marginBottom: 4,
            fontSize: 11, color: 'var(--color-accent-success)',
            background: 'var(--color-bg-secondary)', padding: '4px 8px',
            borderRadius: tokens.radius.md, whiteSpace: 'nowrap',
            border: '1px solid var(--color-border-primary)',
            boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
          }}>
            {t('ratingSubmitted')}
          </span>
        )}
      </div>
    </a>
  )
})
