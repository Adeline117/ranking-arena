'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

// 2026-07-04 下线 bots/exchanges/weekly 三个子导航(U1/#3):数据陈旧/整页空
// (bots 自曝 143 天未刷、exchanges/weekly 全空),挂着自曝烂尾比没有更伤信任。
// 页面 page.tsx 保留(直链仍可达),仅从子导航移除;摄取管线恢复后再挂回。
const TAB_KEYS = [
  { href: '/', key: 'rankingsSubNavTraders' as const },
  { href: '/rankings/tokens', key: 'rankingsSubNavTokens' as const },
]

export default function RankingsSubNav() {
  const pathname = usePathname()
  const { t } = useLanguage()

  return (
    <nav
      aria-label={t('rankingsSubNavAriaLabel')}
      style={{
        display: 'flex',
        gap: tokens.spacing[1],
        marginTop: 4,
      }}
    >
      {TAB_KEYS.map((tab) => {
        const isActive =
          tab.href === '/'
            ? pathname === '/' ||
              pathname === '/rankings' ||
              (pathname.startsWith('/rankings/') &&
                !pathname.startsWith('/rankings/tokens') &&
                !pathname.startsWith('/rankings/exchanges') &&
                !pathname.startsWith('/rankings/weekly'))
            : pathname.startsWith(tab.href)
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={isActive ? 'page' : undefined}
            style={{
              padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
              fontSize: tokens.typography.fontSize.sm,
              fontWeight: isActive ? 700 : 500,
              color: isActive ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
              textDecoration: 'none',
              borderBottom: isActive ? '2px solid var(--color-brand)' : '2px solid transparent',
              whiteSpace: 'nowrap',
              transition: `all ${tokens.transition.fast}`,
              minHeight: 44,
              display: 'inline-flex',
              alignItems: 'center',
            }}
          >
            {t(tab.key)}
          </Link>
        )
      })}
    </nav>
  )
}
