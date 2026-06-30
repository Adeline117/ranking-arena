'use client'

/**
 * AdminTabs — accessible tablist primitive for admin pages.
 *
 * Implements the WAI-ARIA tabs pattern that the hand-written role="tab"
 * buttons were missing: each tab has an id + aria-controls pointing at its
 * tabpanel, roving tabIndex (only the active tab is in the tab order), and
 * ArrowLeft/ArrowRight/Home/End keyboard navigation.
 *
 * The consumer renders a single panel (the active one) with id
 * `tabPanelId(prefix, active)` and aria-labelledby `tabButtonId(prefix, active)`.
 */

import React from 'react'
import { tokens } from '@/lib/design-tokens'
import { Button } from '@/app/components/base'

export interface AdminTabItem {
  id: string
  /** Visible label (may include badges/counts). */
  label: React.ReactNode
  /** Plain-text accessible name — used for the tab's aria-label so screen
   *  readers announce the tab name rather than "Button" when label is a node. */
  ariaLabel: string
}

export function tabButtonId(prefix: string, id: string): string {
  return `${prefix}-tab-${id}`
}

export function tabPanelId(prefix: string, id: string): string {
  return `${prefix}-panel-${id}`
}

interface AdminTabsProps {
  tabs: AdminTabItem[]
  active: string
  onChange: (id: string) => void
  /** aria-label for the tablist landmark. */
  label: string
  /** id namespace shared with the rendered tabpanel. */
  idPrefix: string
}

export default function AdminTabs({ tabs, active, onChange, label, idPrefix }: AdminTabsProps) {
  const handleKeyDown = (e: React.KeyboardEvent, index: number) => {
    let next = index
    switch (e.key) {
      case 'ArrowRight':
        next = (index + 1) % tabs.length
        break
      case 'ArrowLeft':
        next = (index - 1 + tabs.length) % tabs.length
        break
      case 'Home':
        next = 0
        break
      case 'End':
        next = tabs.length - 1
        break
      default:
        return
    }
    e.preventDefault()
    const nextTab = tabs[next]
    onChange(nextTab.id)
    // Button is not forwardRef-able, so move focus by id.
    document.getElementById(tabButtonId(idPrefix, nextTab.id))?.focus()
  }

  return (
    <div
      role="tablist"
      aria-label={label}
      style={{
        display: 'flex',
        gap: tokens.spacing[2],
        marginBottom: tokens.spacing[6],
        flexWrap: 'wrap',
      }}
    >
      {tabs.map((tab, index) => {
        const selected = active === tab.id
        return (
          <Button
            key={tab.id}
            id={tabButtonId(idPrefix, tab.id)}
            role="tab"
            aria-label={tab.ariaLabel}
            aria-selected={selected}
            aria-controls={tabPanelId(idPrefix, tab.id)}
            tabIndex={selected ? 0 : -1}
            variant={selected ? 'primary' : 'secondary'}
            onClick={() => onChange(tab.id)}
            onKeyDown={(e) => handleKeyDown(e, index)}
          >
            {tab.label}
          </Button>
        )
      })}
    </div>
  )
}
