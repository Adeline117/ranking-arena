'use client'

import Link from 'next/link'
import Image from 'next/image'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import type { UnifiedSearchResult } from '@/app/api/search/route'

// 类别配置 - 与 SearchDropdown 保持一致
const CATEGORY_CONFIG = {
  trader: { icon: 'T', labelZh: '交易员', labelEn: 'Traders', color: 'var(--color-verified-web3)' },
  post: { icon: 'P', labelZh: '帖子', labelEn: 'Posts', color: 'var(--color-score-profitability)' },
  library: { icon: 'L', labelZh: '资料库', labelEn: 'Library', color: 'var(--color-score-great)' },
  user: { icon: 'U', labelZh: '用户', labelEn: 'Users', color: 'var(--color-score-average)' },
  group: { icon: 'G', labelZh: '小组', labelEn: 'Groups', color: 'var(--color-score-good)' },
} as const

interface SearchResultsProps {
  results: UnifiedSearchResult[]
  selectedIndex?: number
  onSelect?: (result: UnifiedSearchResult) => void
  grouped?: boolean
}

/**
 * 搜索结果列表组件
 * 支持按类别分组显示或平铺显示
 * 可复用于搜索页面和搜索下拉菜单
 */
export default function SearchResults({
  results,
  selectedIndex = -1,
  onSelect,
  grouped = true,
}: SearchResultsProps) {
  const { language } = useLanguage()

  if (results.length === 0) return null

  const handleClick = (result: UnifiedSearchResult) => {
    onSelect?.(result)
  }

  // 按类型分组
  const groupedResults = grouped
    ? results.reduce(
        (acc, result) => {
          const type = result.type
          if (!acc[type]) acc[type] = []
          acc[type].push(result)
          return acc
        },
        {} as Record<string, UnifiedSearchResult[]>
      )
    : null

  const renderItem = (result: UnifiedSearchResult, index: number) => {
    const config = CATEGORY_CONFIG[result.type] || CATEGORY_CONFIG.post
    const isSelected = index === selectedIndex
    const label = language === 'zh' ? config.labelZh : config.labelEn

    return (
      <Link
        key={`${result.type}-${result.id}`}
        href={result.href}
        style={{ textDecoration: 'none' }}
        onClick={() => handleClick(result)}
      >
        <Box
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: tokens.spacing[3],
            padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
            borderBottom: `1px solid ${tokens.colors.border.primary}`,
            cursor: 'pointer',
            background: isSelected ? tokens.colors.bg.tertiary : 'transparent',
            transition: 'background 0.1s',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = tokens.colors.bg.tertiary
          }}
          onMouseLeave={(e) => {
            if (!isSelected) {
              e.currentTarget.style.background = 'transparent'
            }
          }}
        >
          {result.avatar ? (
            <Image
              src={result.avatar}
              alt={result.title || 'Avatar'}
              width={36}
              height={36}
              style={{
                width: 36,
                height: 36,
                borderRadius: tokens.radius.full,
                objectFit: 'cover',
                flexShrink: 0,
              }}
              unoptimized={result.avatar.startsWith('data:')}
            />
          ) : (
            <Box
              style={{
                width: 36,
                height: 36,
                borderRadius: tokens.radius.full,
                background: `${config.color}15`,
                color: config.color,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 14,
                fontWeight: 700,
                flexShrink: 0,
              }}
            >
              {config.icon}
            </Box>
          )}
          <Box style={{ flex: 1, minWidth: 0 }}>
            <Text
              size="sm"
              weight="bold"
              style={{
                color: tokens.colors.text.primary,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {result.title}
            </Text>
            <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2], marginTop: 2 }}>
              {!grouped && (
                <Text
                  size="xs"
                  style={{
                    color: config.color,
                    fontWeight: 600,
                  }}
                >
                  {label}
                </Text>
              )}
              {result.subtitle && (
                <Text size="xs" color="tertiary">
                  {!grouped && '· '}{result.subtitle}
                </Text>
              )}
            </Box>
          </Box>
        </Box>
      </Link>
    )
  }

  // 分组显示
  if (grouped && groupedResults) {
    const categoryOrder: Array<UnifiedSearchResult['type']> = [
      'trader',
      'post',
      'user',
      'group',
    ]
    let globalIndex = 0

    return (
      <Box>
        {categoryOrder.map((type) => {
          const items = groupedResults[type]
          if (!items || items.length === 0) return null
          const config = CATEGORY_CONFIG[type]
          const label = language === 'zh' ? config.labelZh : config.labelEn

          return (
            <Box key={type}>
              <Box
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: tokens.spacing[2],
                  padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
                  background: `${config.color}08`,
                  borderBottom: `1px solid ${tokens.colors.border.primary}`,
                }}
              >
                <Box
                  style={{
                    width: 18,
                    height: 18,
                    borderRadius: tokens.radius.sm,
                    background: `${config.color}20`,
                    color: config.color,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 10,
                    fontWeight: 800,
                  }}
                >
                  {config.icon}
                </Box>
                <Text
                  size="xs"
                  weight="bold"
                  style={{
                    color: config.color,
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                  }}
                >
                  {label}
                </Text>
              </Box>
              {items.map((item) => {
                const idx = globalIndex++
                return renderItem(item, idx)
              })}
            </Box>
          )
        })}
      </Box>
    )
  }

  // 平铺显示
  return <Box>{results.map((result, index) => renderItem(result, index))}</Box>
}
