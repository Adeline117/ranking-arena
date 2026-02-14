'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

const TABS = [
  { href: '/', labelZh: '交易员', labelEn: 'Traders' },
  { href: '/rankings/resources', labelZh: '资料', labelEn: 'Resources' },
  { href: '/rankings/institutions', labelZh: '机构', labelEn: 'Institutions' },
  { href: '/rankings/tools', labelZh: '工具', labelEn: 'Tools' },
]

export default function HomeSubNav() {
  const pathname = usePathname()
  const { language } = useLanguage()
  const isZh = language === 'zh'

  return (
    <nav
      aria-label={isZh ? '分类导航' : 'Category navigation'}
      style={{
        display: 'flex',
        gap: tokens.spacing[1],
        marginTop: 4,
      }}
    >
      {TABS.map((tab) => {
        const isActive = tab.href === '/' ? pathname === '/' : pathname.startsWith(tab.href)
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className="btn-press"
            style={{
              padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
              fontSize: tokens.typography.fontSize.sm,
              fontWeight: isActive ? 700 : 500,
              color: isActive ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
              textDecoration: 'none',
              borderBottom: isActive ? '2px solid var(--color-brand)' : '2px solid transparent',
              whiteSpace: 'nowrap',
              transition: `all ${tokens.transition.fast}`,
              borderRadius: `${tokens.radius.md} ${tokens.radius.md} 0 0`,
            }}
            onMouseEnter={(e) => {
              if (!isActive) {
                e.currentTarget.style.color = 'var(--color-text-primary)'
                e.currentTarget.style.backgroundColor = 'var(--color-bg-hover)'
              }
            }}
            onMouseLeave={(e) => {
              if (!isActive) {
                e.currentTarget.style.color = 'var(--color-text-secondary)'
                e.currentTarget.style.backgroundColor = 'transparent'
              }
            }}
          >
            {isZh ? tab.labelZh : tab.labelEn}
          </Link>
        )
      })}
    </nav>
  )
}
