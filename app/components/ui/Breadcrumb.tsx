'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { generateBreadcrumbSchema } from '@/lib/seo/structured-data'
import { BASE_URL } from '@/lib/constants/urls'

export interface BreadcrumbItem {
  label: string
  href?: string
}

interface BreadcrumbProps {
  items: BreadcrumbItem[]
  /**
   * Opt-in: emit BreadcrumbList JSON-LD structured data for SEO. Default off so
   * existing call sites are unaffected. Only enable on pages whose hrefs form a
   * canonical, crawlable trail.
   */
  jsonLd?: boolean
}

// Sentinel marking the collapsed middle segment on narrow viewports.
const ELLIPSIS = { ellipsis: true } as const
type RenderEntry = BreadcrumbItem | typeof ELLIPSIS
const isEllipsis = (e: RenderEntry): e is typeof ELLIPSIS => 'ellipsis' in e

export default function Breadcrumb({ items, jsonLd = false }: BreadcrumbProps) {
  const { t } = useLanguage()
  const homeLabel = t('home')

  const allItems: BreadcrumbItem[] = [{ label: homeLabel, href: '/' }, ...items]

  // Collapse the middle of long trails on narrow viewports so the current page
  // stays visible instead of being clipped by overflow:hidden. Starts false on
  // both server and first client render (no hydration mismatch), then syncs.
  const [isNarrow, setIsNarrow] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 640px)')
    const sync = () => setIsNarrow(mq.matches)
    sync()
    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
  }, [])

  const shouldCollapse = isNarrow && allItems.length > 3
  const rendered: RenderEntry[] = shouldCollapse
    ? [allItems[0], ELLIPSIS, allItems[allItems.length - 1]]
    : allItems

  return (
    <nav
      aria-label="Breadcrumb"
      style={{
        padding: `${tokens.spacing[2]} 0`,
        fontSize: tokens.typography.fontSize.xs,
        lineHeight: '1.5',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      }}
    >
      {jsonLd && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify(
              generateBreadcrumbSchema(
                allItems.map((item) => ({
                  name: item.label,
                  ...(item.href
                    ? { url: item.href.startsWith('http') ? item.href : `${BASE_URL}${item.href}` }
                    : {}),
                }))
              )
            ),
          }}
        />
      )}
      <ol
        style={{
          listStyle: 'none',
          margin: 0,
          padding: 0,
          display: 'inline',
        }}
      >
        {rendered.map((entry, idx) => {
          const isLast = idx === rendered.length - 1
          if (isEllipsis(entry)) {
            return (
              <li
                key="ellipsis"
                style={{ display: 'inline', color: 'var(--color-text-tertiary, #8E8E9E)' }}
              >
                <span
                  style={{
                    margin: `0 ${tokens.spacing[1.5]}`,
                    color: 'var(--color-text-tertiary, #8E8E9E)',
                    opacity: 0.5,
                    userSelect: 'none',
                  }}
                  aria-hidden="true"
                >
                  /
                </span>
                <span style={{ userSelect: 'none' }}>…</span>
              </li>
            )
          }
          const item = entry
          return (
            <li
              key={idx}
              style={{
                display: 'inline',
                color: isLast
                  ? 'var(--color-text-primary, #EDEDED)'
                  : 'var(--color-text-tertiary, #8E8E9E)',
              }}
            >
              {idx > 0 && (
                <span
                  style={{
                    margin: `0 ${tokens.spacing[1.5]}`,
                    color: 'var(--color-text-tertiary, #8E8E9E)',
                    opacity: 0.5,
                    userSelect: 'none',
                  }}
                  aria-hidden="true"
                >
                  /
                </span>
              )}
              {isLast || !item.href ? (
                <span
                  style={{
                    fontWeight: isLast ? 600 : 400,
                  }}
                  aria-current={isLast ? 'page' : undefined}
                >
                  {item.label}
                </span>
              ) : (
                <Link
                  href={item.href}
                  style={{
                    color: 'inherit',
                    textDecoration: 'none',
                    transition: 'color 0.15s',
                    display: 'inline-flex',
                    alignItems: 'center',
                    minHeight: 44,
                    padding: `${tokens.spacing[2]} ${tokens.spacing[1]}`,
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.color = 'var(--color-brand, #8b6fa8)'
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.color = 'var(--color-text-tertiary, #8E8E9E)'
                  }}
                >
                  {item.label}
                </Link>
              )}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
