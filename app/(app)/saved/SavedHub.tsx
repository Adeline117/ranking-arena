'use client'

/**
 * 统一"我的收藏 / Saved"hub(2026-07-04 #4)。
 *
 * owner 洞察:用户脑中"我收藏的东西"是一个概念,不区分收的是交易员还是帖子;
 * 此前 /watchlist(交易员)与 /favorites(帖子+文件夹)是两个独立顶级入口 = 混淆源。
 * 但两者数据实体不同(trader_watchlist vs bookmark_folders),不能合并数据层。
 * 解法:UI 合一 + 数据分离——一个 hub 页,两个 tab 各自复用现有 client 组件,
 * 底层表/hook/API 原封不动。用户从此只有一个"收藏"目的地。
 */

import { useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import WatchlistClient from '../watchlist/WatchlistClient'
import FavoritesPageClient from '../favorites/FavoritesPageClient'

type SavedTab = 'traders' | 'posts'

export default function SavedHub() {
  const { t } = useLanguage()
  const params = useSearchParams()
  const tab: SavedTab = params.get('tab') === 'posts' ? 'posts' : 'traders'

  const TABS: Array<{ id: SavedTab; label: string }> = [
    { id: 'traders', label: t('savedTabTraders') },
    { id: 'posts', label: t('savedTabPosts') },
  ]

  return (
    <div style={{ maxWidth: 1120, margin: '0 auto', padding: `0 ${tokens.spacing[4]}` }}>
      <h1
        style={{
          fontSize: tokens.typography.fontSize['2xl'],
          fontWeight: tokens.typography.fontWeight.bold,
          color: 'var(--color-text-primary)',
          margin: `${tokens.spacing[5]} 0 ${tokens.spacing[1]}`,
        }}
      >
        {t('savedHubTitle')}
      </h1>

      {/* Tab 栏 — 交易员 / 帖子。用 Link 切 ?tab,SSR 友好 */}
      <nav
        aria-label={t('savedHubTitle')}
        style={{
          display: 'flex',
          gap: tokens.spacing[2],
          borderBottom: '1px solid var(--color-border-primary)',
          marginBottom: tokens.spacing[4],
        }}
      >
        {TABS.map((tb) => {
          const active = tb.id === tab
          return (
            <Link
              key={tb.id}
              href={`/saved?tab=${tb.id}`}
              scroll={false}
              style={{
                padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                fontSize: tokens.typography.fontSize.sm,
                fontWeight: active
                  ? tokens.typography.fontWeight.bold
                  : tokens.typography.fontWeight.medium,
                color: active ? 'var(--color-brand)' : 'var(--color-text-secondary)',
                borderBottom: active ? '2px solid var(--color-brand)' : '2px solid transparent',
                textDecoration: 'none',
                marginBottom: -1,
              }}
              aria-current={active ? 'page' : undefined}
            >
              {tb.label}
            </Link>
          )
        })}
      </nav>

      {/* 内容 — 复用现成 client,数据层零改动。embedded 抑制各自的整页 chrome
          (100vh 包裹 / PageHeader / Breadcrumb / FAB),只渲染内容,避免堆叠标题。 */}
      {tab === 'posts' ? <FavoritesPageClient embedded /> : <WatchlistClient embedded />}
    </div>
  )
}
