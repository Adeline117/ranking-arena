'use client'

import { useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { useComparisonStore, type CompareTrader } from '@/lib/stores'
import { useSubscription } from '@/app/components/home/hooks/useSubscription'
import { useToast } from '@/app/components/ui/Toast'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { tokens } from '@/lib/design-tokens'

interface AddCompareButtonProps {
  trader: CompareTrader
  variant?: 'icon' | 'text' | 'compact'
  size?: 'sm' | 'md'
  className?: string
}

export default function AddCompareButton({
  trader,
  variant = 'icon',
  size = 'sm',
  className = '',
}: AddCompareButtonProps) {
  const { t } = useLanguage()
  const router = useRouter()
  const { showToast } = useToast()
  const { isPro } = useSubscription()
  const { addTrader, removeTrader, isSelected, canAddMore, selectedTraders } = useComparisonStore()

  const selected = isSelected(trader.id)
  const count = selectedTraders.length

  const handleClick = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()

    if (selected) {
      removeTrader(trader.id)
      showToast(t('compareRemoved') || 'Removed from comparison', 'info')
      return
    }

    if (!isPro) {
      showToast(t('proFeatureOnly') || 'Pro feature - upgrade to compare traders', 'warning')
      router.push('/pricing')
      return
    }

    if (!canAddMore()) {
      showToast(t('compareMax5') || 'Maximum 5 traders can be compared', 'warning')
      return
    }

    const added = addTrader(trader)
    if (added) {
      showToast(t('compareAdded') || 'Added to comparison', 'success')
    }
  }, [selected, isPro, trader, addTrader, removeTrader, canAddMore, showToast, t, router])

  const buttonSize = size === 'sm' ? 28 : 36
  const iconSize = size === 'sm' ? 14 : 18

  // Icon variant - just the icon
  if (variant === 'icon') {
    return (
      <button
        onClick={handleClick}
        className={`btn-press ${className}`}
        title={selected ? (t('removeFromCompare') || 'Remove from compare') : (t('addToCompare') || 'Add to compare')}
        style={{
          width: buttonSize,
          height: buttonSize,
          borderRadius: tokens.radius.md,
          border: selected ? `1px solid ${tokens.colors.accent.primary}` : tokens.glass.border.light,
          background: selected ? `${tokens.colors.accent.primary}20` : tokens.glass.bg.light,
          color: selected ? tokens.colors.accent.primary : tokens.colors.text.secondary,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          transition: tokens.transition.all,
          flexShrink: 0,
        }}
      >
        <svg width={iconSize} height={iconSize} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
          {selected ? (
            // Check icon when selected
            <path d="M20 6L9 17l-5-5" strokeLinecap="round" strokeLinejoin="round" />
          ) : (
            // Chart comparison icon
            <>
              <rect x="3" y="10" width="4" height="10" rx="1" />
              <rect x="10" y="6" width="4" height="14" rx="1" />
              <rect x="17" y="2" width="4" height="18" rx="1" />
            </>
          )}
        </svg>
      </button>
    )
  }

  // Compact variant - icon with count badge
  if (variant === 'compact') {
    return (
      <button
        onClick={handleClick}
        className={`btn-press ${className}`}
        title={selected ? (t('removeFromCompare') || 'Remove from compare') : (t('addToCompare') || 'Add to compare')}
        style={{
          padding: '6px 10px',
          borderRadius: tokens.radius.md,
          border: selected ? `1px solid ${tokens.colors.accent.primary}` : tokens.glass.border.light,
          background: selected ? `${tokens.colors.accent.primary}20` : tokens.glass.bg.light,
          color: selected ? tokens.colors.accent.primary : tokens.colors.text.secondary,
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          cursor: 'pointer',
          transition: tokens.transition.all,
          fontSize: tokens.typography.fontSize.sm,
          fontWeight: 600,
        }}
      >
        <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
          {selected ? (
            <path d="M20 6L9 17l-5-5" strokeLinecap="round" strokeLinejoin="round" />
          ) : (
            <>
              <rect x="3" y="10" width="4" height="10" rx="1" />
              <rect x="10" y="6" width="4" height="14" rx="1" />
              <rect x="17" y="2" width="4" height="18" rx="1" />
            </>
          )}
        </svg>
        {count > 0 && (
          <span style={{
            padding: '1px 5px',
            borderRadius: tokens.radius.sm,
            background: tokens.colors.accent.primary,
            color: tokens.colors.white,
            fontSize: tokens.typography.fontSize.xs,
            fontWeight: 700,
          }}>
            {count}/5
          </span>
        )}
      </button>
    )
  }

  // Text variant - full button with text
  return (
    <button
      onClick={handleClick}
      className={`btn-press ${className}`}
      style={{
        padding: size === 'sm' ? '8px 12px' : '10px 16px',
        borderRadius: tokens.radius.md,
        border: selected ? `1px solid ${tokens.colors.accent.primary}` : tokens.glass.border.light,
        background: selected ? `${tokens.colors.accent.primary}20` : tokens.glass.bg.light,
        color: selected ? tokens.colors.accent.primary : tokens.colors.text.secondary,
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        cursor: 'pointer',
        transition: tokens.transition.all,
        fontSize: size === 'sm' ? '13px' : '14px',
        fontWeight: 600,
      }}
    >
      <svg width={iconSize} height={iconSize} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
        {selected ? (
          <path d="M20 6L9 17l-5-5" strokeLinecap="round" strokeLinejoin="round" />
        ) : (
          <>
            <rect x="3" y="10" width="4" height="10" rx="1" />
            <rect x="10" y="6" width="4" height="14" rx="1" />
            <rect x="17" y="2" width="4" height="18" rx="1" />
          </>
        )}
      </svg>
      {selected ? (t('inCompare') || 'In Compare') : (t('compare') || 'Compare')}
    </button>
  )
}
