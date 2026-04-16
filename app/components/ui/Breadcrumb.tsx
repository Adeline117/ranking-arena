'use client'

import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

export interface BreadcrumbItem {
  label: string
  href?: string
}

interface BreadcrumbProps {
  items: BreadcrumbItem[]
}

export default function Breadcrumb({ items }: BreadcrumbProps) {
  const { t } = useLanguage()
  const homeLabel = t('home')

  const allItems: BreadcrumbItem[] = [
    { label: homeLabel, href: '/' },
    ...items,
  ]

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
      <ol
        style={{
          listStyle: 'none',
          margin: 0,
          padding: 0,
          display: 'inline',
        }}
      >
        {allItems.map((item, idx) => {
          const isLast = idx === allItems.length - 1
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
