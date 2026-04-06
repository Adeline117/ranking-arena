'use client'

import { tokens } from '@/lib/design-tokens'
import { Box } from '@/app/components/base'
import { SortButton } from './components'
import { getSourceDisplayName } from './types'
import type { SortMode } from './types'

type FilterSortBarProps = {
  searchQuery: string
  onSearchChange: (value: string) => void
  platformFilter: string
  onPlatformFilterChange: (value: string) => void
  availablePlatforms: string[]
  sortMode: SortMode
  onSortModeChange: (mode: SortMode) => void
  language: string
  t: (key: string) => string
}

export default function FilterSortBar({
  searchQuery,
  onSearchChange,
  platformFilter,
  onPlatformFilterChange,
  availablePlatforms,
  sortMode,
  onSortModeChange,
  language,
  t,
}: FilterSortBarProps) {
  return (
    <>
      {/* ============= 搜索 + 平台筛选 ============= */}
      <Box style={{
        display: 'flex',
        gap: tokens.spacing[3],
        marginBottom: tokens.spacing[3],
        flexWrap: 'wrap',
      }}>
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder={t('searchFollowingPlaceholder')}
          style={{
            flex: '1 1 200px',
            padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
            borderRadius: tokens.radius.lg,
            border: `1px solid ${tokens.colors.border.primary}`,
            background: tokens.colors.bg.secondary,
            color: tokens.colors.text.primary,
            fontSize: tokens.typography.fontSize.sm,
            outline: 'none',
            minHeight: 40,
          }}
        />
        <select
          value={platformFilter}
          onChange={(e) => onPlatformFilterChange(e.target.value)}
          style={{
            padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
            borderRadius: tokens.radius.lg,
            border: `1px solid ${tokens.colors.border.primary}`,
            background: tokens.colors.bg.secondary,
            color: tokens.colors.text.primary,
            fontSize: tokens.typography.fontSize.sm,
            cursor: 'pointer',
            minHeight: 40,
          }}
        >
          <option value="all">{t('allPlatformsFilter')}</option>
          <option value="user">{t('usersFilter')}</option>
          {availablePlatforms.map(p => (
            <option key={p} value={p}>{getSourceDisplayName(p, language)}</option>
          ))}
        </select>
      </Box>

      {/* ============= 排序控制 ============= */}
      <Box style={{
        display: 'flex',
        alignItems: 'center',
        gap: tokens.spacing[1],
        marginBottom: tokens.spacing[3],
        padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
        background: tokens.colors.bg.secondary,
        borderRadius: tokens.radius.full,
        width: 'fit-content',
      }}>
        <SortButton
          label={t('sortByRecent')}
          active={sortMode === 'recent'}
          onClick={() => onSortModeChange('recent')}
        />
        <SortButton
          label={t('sortByRoi')}
          active={sortMode === 'roi'}
          onClick={() => onSortModeChange('roi')}
        />
        <SortButton
          label={t('sortByScore')}
          active={sortMode === 'score'}
          onClick={() => onSortModeChange('score')}
        />
      </Box>
    </>
  )
}
