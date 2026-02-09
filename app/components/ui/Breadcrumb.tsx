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
  const { language } = useLanguage()
  const homeLabel = language === 'zh' ? '首页' : 'Home'

  const allItems: BreadcrumbItem[] = [
    { label: homeLabel, href: '/' },
    ...items,
  ]

  return (
    <nav aria-label="Breadcrumb" style={{ padding: '8px 0', fontSize: tokens.typography.fontSize.xs }}>
      <ol
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 0,
          listStyle: 'none',
          margin: 0,
          padding: 0,
          flexWrap: 'wrap',
        }}
      >
        {allItems.map((item, idx) => {
          const isLast = idx === allItems.length - 1
          return (
            <li
              key={idx}
              style={{
                display: 'flex',
                alignItems: 'center',
                color: isLast
                  ? 'var(--color-text-primary, #EDEDED)'
                  : 'var(--color-text-tertiary, #8E8E9E)',
              }}
            >
              {idx > 0 && (
                <span
                  style={{
                    margin: '0 6px',
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
                    maxWidth: 200,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
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
