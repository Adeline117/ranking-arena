'use client'

import { useState, useEffect, useCallback, type ReactNode, type ReactElement } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../base'

const HINT_STORAGE_KEY = 'ranking-arena-dismissed-hints'

export interface FeatureHintProps {
  /** Unique identifier for this hint */
  id: string
  /** The element to attach the hint to */
  children: ReactNode
  /** Hint title */
  title: string
  /** Hint description */
  description: string
  /** Position of the hint tooltip */
  position?: 'top' | 'bottom' | 'left' | 'right'
  /** Show hint immediately on mount */
  showOnMount?: boolean
  /** Delay before showing hint (ms) */
  delay?: number
  /** Whether to persist dismissal across sessions */
  persist?: boolean
  /** Maximum times to show this hint (0 = always show until dismissed) */
  maxShows?: number
  /** Callback when hint is shown */
  onShow?: () => void
  /** Callback when hint is dismissed */
  onDismiss?: () => void
}

interface HintState {
  dismissedAt?: number
  showCount: number
}

function getDismissedHints(): Record<string, HintState> {
  if (typeof window === 'undefined') return {}
  try {
    const stored = localStorage.getItem(HINT_STORAGE_KEY)
    if (!stored) return {}
    return JSON.parse(stored)
  } catch {
    return {}
  }
}

function saveDismissedHints(hints: Record<string, HintState>): void {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(HINT_STORAGE_KEY, JSON.stringify(hints))
  } catch {
    // Silently fail if localStorage is full
  }
}

/**
 * FeatureHint - A tooltip component for feature discovery
 *
 * Shows helpful hints for features that users may not have discovered yet.
 * Hints can be dismissed and the dismissal persists across sessions.
 *
 * @example
 * ```tsx
 * <FeatureHint
 *   id="search-filters"
 *   title="Advanced Filters"
 *   description="Use filters to narrow down traders by exchange, ROI, and more"
 *   position="bottom"
 * >
 *   <FilterButton />
 * </FeatureHint>
 * ```
 */
export function FeatureHint({
  id,
  children,
  title,
  description,
  position = 'bottom',
  showOnMount = false,
  delay = 500,
  persist = true,
  maxShows = 3,
  onShow,
  onDismiss,
}: FeatureHintProps): ReactElement {
  const [isVisible, setIsVisible] = useState(false)
  const [isDismissed, setIsDismissed] = useState(false)
  const [showCount, setShowCount] = useState(0)

  // Check if hint should be shown
  useEffect(() => {
    const hints = getDismissedHints()
    const hintState = hints[id]

    if (hintState?.dismissedAt) {
      setIsDismissed(true)
      return
    }

    const currentShowCount = hintState?.showCount || 0
    setShowCount(currentShowCount)

    // Check maxShows limit
    if (maxShows > 0 && currentShowCount >= maxShows) {
      setIsDismissed(true)
      return
    }

    if (showOnMount) {
      const timer = setTimeout(() => {
        setIsVisible(true)
        onShow?.()

        // Increment show count
        if (persist) {
          const updatedHints = {
            ...hints,
            [id]: { ...hintState, showCount: currentShowCount + 1 },
          }
          saveDismissedHints(updatedHints)
        }
      }, delay)

      return () => clearTimeout(timer)
    }
  }, [id, showOnMount, delay, persist, maxShows, onShow])

  const handleDismiss = useCallback(() => {
    setIsVisible(false)
    setIsDismissed(true)

    if (persist) {
      const hints = getDismissedHints()
      hints[id] = {
        ...hints[id],
        dismissedAt: Date.now(),
        showCount: showCount + 1,
      }
      saveDismissedHints(hints)
    }

    onDismiss?.()
  }, [id, persist, showCount, onDismiss])

  const handleMouseEnter = useCallback(() => {
    if (!isDismissed && !showOnMount) {
      setIsVisible(true)
      onShow?.()
    }
  }, [isDismissed, showOnMount, onShow])

  const handleMouseLeave = useCallback(() => {
    if (!showOnMount) {
      setIsVisible(false)
    }
  }, [showOnMount])

  const getPositionStyles = (): React.CSSProperties => {
    const base: React.CSSProperties = {
      position: 'absolute',
      zIndex: tokens.zIndex.tooltip,
      minWidth: 200,
      maxWidth: 280,
    }

    switch (position) {
      case 'top':
        return {
          ...base,
          bottom: '100%',
          left: '50%',
          transform: 'translateX(-50%)',
          marginBottom: tokens.spacing[2],
        }
      case 'bottom':
        return {
          ...base,
          top: '100%',
          left: '50%',
          transform: 'translateX(-50%)',
          marginTop: tokens.spacing[2],
        }
      case 'left':
        return {
          ...base,
          right: '100%',
          top: '50%',
          transform: 'translateY(-50%)',
          marginRight: tokens.spacing[2],
        }
      case 'right':
        return {
          ...base,
          left: '100%',
          top: '50%',
          transform: 'translateY(-50%)',
          marginLeft: tokens.spacing[2],
        }
      default:
        return base
    }
  }

  const getArrowStyles = (): React.CSSProperties => {
    const base: React.CSSProperties = {
      position: 'absolute',
      width: 0,
      height: 0,
      borderStyle: 'solid',
    }

    const arrowSize = 6

    switch (position) {
      case 'top':
        return {
          ...base,
          bottom: -arrowSize,
          left: '50%',
          transform: 'translateX(-50%)',
          borderWidth: `${arrowSize}px ${arrowSize}px 0 ${arrowSize}px`,
          borderColor: `${tokens.colors.bg.tertiary} transparent transparent transparent`,
        }
      case 'bottom':
        return {
          ...base,
          top: -arrowSize,
          left: '50%',
          transform: 'translateX(-50%)',
          borderWidth: `0 ${arrowSize}px ${arrowSize}px ${arrowSize}px`,
          borderColor: `transparent transparent ${tokens.colors.bg.tertiary} transparent`,
        }
      case 'left':
        return {
          ...base,
          right: -arrowSize,
          top: '50%',
          transform: 'translateY(-50%)',
          borderWidth: `${arrowSize}px 0 ${arrowSize}px ${arrowSize}px`,
          borderColor: `transparent transparent transparent ${tokens.colors.bg.tertiary}`,
        }
      case 'right':
        return {
          ...base,
          left: -arrowSize,
          top: '50%',
          transform: 'translateY(-50%)',
          borderWidth: `${arrowSize}px ${arrowSize}px ${arrowSize}px 0`,
          borderColor: `transparent ${tokens.colors.bg.tertiary} transparent transparent`,
        }
      default:
        return base
    }
  }

  return (
    <Box
      style={{ position: 'relative', display: 'inline-block' }}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {children}

      {isVisible && !isDismissed && (
        <Box
          style={{
            ...getPositionStyles(),
            background: tokens.colors.bg.tertiary,
            borderRadius: tokens.radius.lg,
            padding: tokens.spacing[3],
            boxShadow: tokens.shadow.lg,
            border: `1px solid ${tokens.colors.border.primary}`,
            animation: 'fadeIn 0.2s ease-out',
          }}
        >
          {/* Arrow */}
          <div style={getArrowStyles()} />

          {/* Content */}
          <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
            <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: tokens.spacing[2] }}>
              <Text size="sm" weight="bold" style={{ color: tokens.colors.text.primary }}>
                {title}
              </Text>
              <button
                onClick={handleDismiss}
                aria-label="Dismiss hint"
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: tokens.colors.text.tertiary,
                  cursor: 'pointer',
                  padding: 2,
                  lineHeight: 1,
                  fontSize: 14,
                }}
              >
                ×
              </button>
            </Box>
            <Text size="xs" style={{ color: tokens.colors.text.secondary, lineHeight: 1.5 }}>
              {description}
            </Text>
            {showOnMount && (
              <button
                onClick={handleDismiss}
                style={{
                  background: tokens.colors.accent.brand,
                  color: tokens.colors.white,
                  border: 'none',
                  borderRadius: tokens.radius.md,
                  padding: `${tokens.spacing[1]} ${tokens.spacing[3]}`,
                  fontSize: tokens.typography.fontSize.xs,
                  fontWeight: tokens.typography.fontWeight.semibold,
                  cursor: 'pointer',
                  marginTop: tokens.spacing[1],
                  alignSelf: 'flex-start',
                }}
              >
                Got it
              </button>
            )}
          </Box>
        </Box>
      )}
    </Box>
  )
}

/**
 * Hook to check if a hint has been dismissed
 */
export function useHintDismissed(hintId: string): boolean {
  const [dismissed, setDismissed] = useState(true) // Default to true to prevent flicker

  useEffect(() => {
    const hints = getDismissedHints()
    setDismissed(!!hints[hintId]?.dismissedAt)
  }, [hintId])

  return dismissed
}

/**
 * Hook to manually dismiss a hint
 */
export function useDismissHint(): (hintId: string) => void {
  return useCallback((hintId: string) => {
    const hints = getDismissedHints()
    hints[hintId] = {
      ...hints[hintId],
      dismissedAt: Date.now(),
      showCount: (hints[hintId]?.showCount || 0) + 1,
    }
    saveDismissedHints(hints)
  }, [])
}

/**
 * Utility to reset all dismissed hints (for testing/debugging)
 */
export function resetAllHints(): void {
  if (typeof window === 'undefined') return
  localStorage.removeItem(HINT_STORAGE_KEY)
}

export default FeatureHint
