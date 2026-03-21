'use client'

import { useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box } from '../base'
import { useLanguage } from '../Providers/LanguageProvider'
import { useToast } from '../ui/Toast'
import { PLATFORM_CATEGORY } from '@/lib/types/leaderboard'

export type CategoryType = 'all' | 'futures' | 'spot' | 'web3'

interface CategoryRankingTabsProps {
  currentCategory: CategoryType
  onCategoryChange: (category: CategoryType) => void
  isPro: boolean
  onProRequired?: () => void
}

// 锁图标
const LockIcon = ({ size = 10 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path
      d="M19 11H5C3.9 11 3 11.9 3 13V20C3 21.1 3.9 22 5 22H19C20.1 22 21 21.1 21 20V13C21 11.9 20.1 11 19 11Z"
      fill="currentColor"
    />
    <path
      d="M7 11V7C7 4.2 9.2 2 12 2C14.8 2 17 4.2 17 7V11"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    />
  </svg>
)

export default function CategoryRankingTabs({
  currentCategory,
  onCategoryChange,
  isPro,
  onProRequired,
}: CategoryRankingTabsProps) {
  const { language, t } = useLanguage()
  const { showToast } = useToast()
  const [hoveredTab, setHoveredTab] = useState<CategoryType | null>(null)

  // 使用翻译的分类配置
  const CATEGORIES: Array<{ value: CategoryType; label: string }> = [
    { value: 'all', label: t('categoryAll') },
    { value: 'futures', label: t('categoryFutures') },
    { value: 'spot', label: t('categorySpot') },
    { value: 'web3', label: t('categoryWeb3') },
  ]

  const handleTabClick = (category: CategoryType) => {
    if (category !== 'all' && !isPro) {
      if (onProRequired) {
        onProRequired()
      } else {
        // 默认提示：如果父组件没有传入 onProRequired
        showToast(
          t('proRequired'),
          'warning'
        )
      }
      return
    }
    onCategoryChange(category)
  }

  return (
    <Box
      role="tablist"
      aria-label={t('rankingCategoriesLabel')}
      className="category-tabs swipe-container"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: 4,
        background: 'var(--color-bg-tertiary)',
        borderRadius: tokens.radius.xl,
        border: '1px solid var(--color-border-secondary)',
        overflowX: 'auto',
        WebkitOverflowScrolling: 'touch',
        scrollbarWidth: 'none',
        msOverflowStyle: 'none',
      }}
    >
      {CATEGORIES.map((cat) => {
        const isActive = currentCategory === cat.value
        const isHovered = hoveredTab === cat.value
        const isLocked = cat.value !== 'all' && !isPro

        return (
          <button
            key={cat.value}
            role="tab"
            aria-selected={isActive}
            aria-disabled={isLocked}
            onClick={() => handleTabClick(cat.value)}
            onMouseEnter={() => setHoveredTab(cat.value)}
            onMouseLeave={() => setHoveredTab(null)}
            className="touch-target-sm"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
              padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
              minHeight: 44,
              minWidth: 'fit-content',
              whiteSpace: 'nowrap',
              borderRadius: tokens.radius.lg,
              border: 'none',
              background: isActive
                ? 'var(--color-pro-badge-bg)'
                : isHovered && !isLocked
                  ? 'var(--color-bg-secondary)'
                  : 'transparent',
              color: isActive
                ? tokens.colors.white
                : isLocked
                  ? tokens.colors.text.tertiary
                  : 'var(--color-text-secondary)',
              cursor: isLocked ? 'not-allowed' : 'pointer',
              fontSize: tokens.typography.fontSize.sm,
              fontWeight: isActive ? 700 : 500,
              transition: `all ${tokens.transition.base}`,
              boxShadow: isActive ? '0 2px 8px var(--color-pro-badge-shadow)' : 'none',
              flexShrink: 0,
            }}
          >
            <span>{cat.label}</span>
            {isLocked && (
              <LockIcon size={12} />
            )}
          </button>
        )
      })}
    </Box>
  )
}

// CategoryType → TradingCategory 映射
const CATEGORY_TO_TRADING: Record<Exclude<CategoryType, 'all'>, string> = {
  futures: 'futures',
  spot: 'spot',
  web3: 'onchain',
}

// 从 PLATFORM_CATEGORY 构建分类平台集合（唯一真实来源）
const _categoryPlatformSets = (() => {
  const sets: Record<string, Set<string>> = { futures: new Set(), spot: new Set(), onchain: new Set() }
  for (const [platform, cat] of Object.entries(PLATFORM_CATEGORY)) {
    sets[cat]?.add(platform)
  }
  return sets
})()

// 过滤函数 — 使用 PLATFORM_CATEGORY 作为唯一真实来源
export function filterByCategory(source: string, category: CategoryType): boolean {
  if (category === 'all') return true
  const tradingCat = CATEGORY_TO_TRADING[category]
  if (!tradingCat) return true
  return _categoryPlatformSets[tradingCat]?.has(source.toLowerCase()) ?? false
}

// 获取分类的来源列表 — 从 PLATFORM_CATEGORY 动态生成
export function getSourcesForCategory(category: CategoryType): string[] {
  if (category === 'all') return []
  const tradingCat = CATEGORY_TO_TRADING[category]
  if (!tradingCat) return []
  return Array.from(_categoryPlatformSets[tradingCat] ?? [])
}
