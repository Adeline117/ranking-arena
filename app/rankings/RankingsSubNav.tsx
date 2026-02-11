'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

const TABS = [
  { href: '/rankings/traders', labelZh: '交易员', labelEn: 'Traders' },
  { href: '/rankings/bots', labelZh: 'Web3 机器人', labelEn: 'Web3 Bots' },
  { href: '/rankings/resources', labelZh: '资料', labelEn: 'Resources' },
  { href: '/rankings/institutions', labelZh: '机构', labelEn: 'Institutions' },
  { href: '/rankings/tools', labelZh: '工具', labelEn: 'Tools' },
]

export default function RankingsSubNav() {
  const pathname = usePathname()
  const { language } = useLanguage()
  const isZh = language === 'zh'

  return (
    <nav
      aria-label={isZh ? '排名分类导航' : 'Rankings category navigation'}
      style={{
        position: 'sticky',
        top: 56,
        zIndex: 40,
        background: 'var(--color-bg-primary)',
        borderBottom: '1px solid var(--color-border-primary)',
      }}
    >
      <div
        style={{
          maxWidth: 1200,
          margin: '0 auto',
          padding: `0 ${tokens.spacing[4]}`,
          display: 'flex',
          gap: tokens.spacing[1],
          overflowX: 'auto',
          scrollbarWidth: 'none',
        }}
      >
        {TABS.map((tab) => {
          const isActive = pathname.startsWith(tab.href)
          return (
            <Link
              key={tab.href}
              href={tab.href}
              style={{
                padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
                fontSize: tokens.typography.fontSize.sm,
                fontWeight: isActive ? 700 : 500,
                color: isActive ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
                textDecoration: 'none',
                borderBottom: isActive ? '2px solid var(--color-brand)' : '2px solid transparent',
                whiteSpace: 'nowrap',
                transition: `all ${tokens.transition.fast}`,
              }}
            >
              {isZh ? tab.labelZh : tab.labelEn}
            </Link>
          )
        })}
      </div>
    </nav>
  )
}
