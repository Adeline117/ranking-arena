'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { tokens } from '@/lib/design-tokens'
import { features } from '@/lib/features'
import { Box } from '../base'
import { useLanguage } from '../Providers/LanguageProvider'
import { usePostStore } from '@/lib/stores/postStore'

export default function NavLinks() {
  const { t, language } = useLanguage()
  const pathname = usePathname()

  const items = [
    { href: '/rankings', labelKey: 'rankings' as const, tooltip: undefined as string | undefined },
    ...(features.social ? [
      { href: '/groups', labelKey: 'groups' as const, tooltip: language === 'zh' ? '加入讨论小组' : 'Join discussion groups' },
    ] : []),
    { href: '/market', labelKey: 'market' as const, tooltip: language === 'zh' ? '市场数据总览' : 'Market overview' },
    { href: '/flash-news', labelKey: 'flashNews' as const, tooltip: language === 'zh' ? '快讯资讯' : 'Flash news' },
    { href: '/library', labelKey: 'library' as const, tooltip: language === 'zh' ? '学习资料库' : 'Learning library' },
    ...(features.social ? [
      { href: '/hot', labelKey: 'hot' as const, tooltip: language === 'zh' ? '全站热门帖子' : 'Trending posts' },
    ] : []),
  ]

  return (
    <Box as="nav" aria-label={t('mainNavigation')} className="hide-mobile" style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[1] }}>
      {items.map((item) => {
        const label = t(item.labelKey)
        const isActive = item.href === '/' ? (pathname === '/' || pathname.startsWith('/rankings')) : pathname.startsWith(item.href)
        return (
          <Link
            key={item.href}
            href={item.href}
            className={`top-nav-link${isActive ? ' top-nav-link-active' : ''}`}
            aria-current={isActive ? 'page' : undefined}
            title={item.tooltip}
            onClick={() => {
              // Trigger feed refresh when clicking groups link while already on groups page
              if (item.href === '/groups' && isActive) {
                usePostStore.getState().triggerFeedRefresh()
              }
            }}
            style={{
              padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
              borderRadius: tokens.radius.md,
              color: isActive ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
              textDecoration: 'none',
              fontWeight: isActive ? 800 : 600,
              fontSize: tokens.typography.fontSize.sm,
              background: isActive ? 'var(--color-bg-secondary)' : 'transparent',
              minHeight: 44,
              display: 'inline-flex',
              alignItems: 'center',
            }}
          >
            {label}
          </Link>
        )
      })}
    </Box>
  )
}
