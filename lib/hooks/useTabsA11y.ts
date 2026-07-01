'use client'

/**
 * Shared WAI-ARIA tabs behavior (B2, UIUX_PERPAGE_AUDIT_2026-06-30).
 *
 * Many pages hand-rolled `role="tab"` buttons but skipped the rest of the
 * pattern (aria-controls/aria-selected, tabpanel linkage, roving tabIndex,
 * arrow-key navigation). This hook is the smallest shared primitive that
 * fixes all of them WITHOUT touching each page's visual design: prop getters
 * only, no rendering. Reference implementation: TraderTabs.tsx:126-187.
 *
 * Usage:
 *   const tabsA11y = useTabsA11y({ tabs: ['a','b'], active, onChange, idPrefix: 'fav' })
 *   <div {...tabsA11y.getTabListProps()} aria-label={t('...')} style={...}>
 *     <button {...tabsA11y.getTabProps('a')} onClick={() => onChange('a')} style={...}>
 *   <section {...tabsA11y.getPanelProps('a')}>  // the active tab's content wrapper
 *
 * - Roving tabIndex: active tab is 0, others -1 (one Tab stop for the list).
 * - ArrowLeft/Right cycle selection AND move focus (WAI-ARIA authoring practice).
 * - Enter/Space activate (covers non-button tab elements too).
 * - idPrefix keeps ids unique when a page renders multiple tablists.
 */

import { useCallback } from 'react'

export interface TabsA11yOptions<K extends string> {
  /** Ordered tab keys (must match render order for arrow-key cycling). */
  tabs: readonly K[]
  active: K
  onChange: (key: K) => void
  /** Unique per tablist on the page; ids become `${idPrefix}-tab-${key}`. */
  idPrefix: string
}

export function useTabsA11y<K extends string>({
  tabs,
  active,
  onChange,
  idPrefix,
}: TabsA11yOptions<K>) {
  const tabId = useCallback((key: K) => `${idPrefix}-tab-${key}`, [idPrefix])
  const panelId = useCallback((key: K) => `${idPrefix}-panel-${key}`, [idPrefix])

  const onKeyDown = useCallback(
    (key: K) => (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        onChange(key)
        return
      }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault()
        const currentIndex = tabs.indexOf(active)
        const direction = e.key === 'ArrowLeft' ? -1 : 1
        const next = tabs[(currentIndex + direction + tabs.length) % tabs.length]
        onChange(next)
        // Move focus with selection (roving tabindex pattern).
        document.getElementById(`${idPrefix}-tab-${next}`)?.focus()
      }
    },
    [tabs, active, onChange, idPrefix]
  )

  const getTabListProps = useCallback(() => ({ role: 'tablist' as const }), [])

  const getTabProps = useCallback(
    (key: K) => ({
      role: 'tab' as const,
      id: tabId(key),
      'aria-selected': active === key,
      'aria-controls': panelId(key),
      tabIndex: active === key ? 0 : -1,
      onKeyDown: onKeyDown(key),
    }),
    [active, tabId, panelId, onKeyDown]
  )

  const getPanelProps = useCallback(
    (key: K) => ({
      role: 'tabpanel' as const,
      id: panelId(key),
      'aria-labelledby': tabId(key),
    }),
    [tabId, panelId]
  )

  return { getTabListProps, getTabProps, getPanelProps }
}
