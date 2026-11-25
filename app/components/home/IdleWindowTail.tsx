'use client'

import { useEffect, useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

const NUMBER_LOCALE: Record<string, string> = { en: 'en-US', zh: 'zh-CN', ja: 'ja-JP', ko: 'ko-KR' }

interface IdleWindowTailProps {
  timeRange: string
  /** Single-exchange board, when the list is scoped to one. */
  exchange?: string | null
  /** 'all' or a category tab; ignored for a single-exchange board. */
  category?: string | null
  /** Whether the idle-window tail is currently listed. */
  expanded: boolean
  onChange: (expanded: boolean) => void
}

/** Null = unknown (still loading, or the count could not be read). */
function useIdleWindowCount(
  timeRange: string,
  exchange: string | null | undefined,
  category: string | null | undefined
): number | null {
  const [count, setCount] = useState<number | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    setCount(null)
    const params = new URLSearchParams({ timeRange })
    if (exchange) params.set('exchange', exchange)
    else if (category && category !== 'all') params.set('category', category)
    fetch(`/api/traders/idle-count?${params.toString()}`, { signal: controller.signal })
      .then((response) => (response.ok ? response.json() : null))
      .then((body: unknown) => {
        const value = (body as { data?: { count?: unknown } } | null)?.data?.count
        setCount(typeof value === 'number' && Number.isSafeInteger(value) ? value : null)
      })
      .catch(() => {
        // Aborted or failed: the count stays unknown and the note stays hidden.
      })
    return () => controller.abort()
  }, [timeRange, exchange, category])
  return count
}

/**
 * The end of the ranking list: accounts with no trading this period are ranked
 * at the tail and hidden by default. This says how many there are and lets the
 * reader list them (or hide them again). Renders nothing when there are none
 * or when the count is unknown — never a "0 more" or a guessed number.
 */
export default function IdleWindowTail({
  timeRange,
  exchange,
  category,
  expanded,
  onChange,
}: IdleWindowTailProps) {
  const { t, language } = useLanguage()
  const count = useIdleWindowCount(timeRange, exchange, category)
  if (!expanded && (count === null || count === 0)) return null

  return (
    <div
      data-testid="idle-window-tail"
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        justifyContent: 'center',
        gap: tokens.spacing[2],
        padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
        fontSize: tokens.typography.fontSize.sm,
        color: tokens.colors.text.tertiary,
      }}
    >
      {!expanded && count !== null && (
        <span>
          {t('idleWindowTailHidden').replace(
            '{count}',
            count.toLocaleString(NUMBER_LOCALE[language] ?? 'en-US')
          )}
        </span>
      )}
      <button
        type="button"
        onClick={() => onChange(!expanded)}
        aria-expanded={expanded}
        style={{
          minHeight: 44,
          padding: `0 ${tokens.spacing[3]}`,
          background: 'transparent',
          border: `1px solid ${tokens.colors.border.primary}`,
          borderRadius: tokens.radius.md,
          color: tokens.colors.text.secondary,
          fontSize: tokens.typography.fontSize.sm,
          cursor: 'pointer',
        }}
      >
        {expanded ? t('idleWindowHide') : t('idleWindowShow')}
      </button>
    </div>
  )
}
