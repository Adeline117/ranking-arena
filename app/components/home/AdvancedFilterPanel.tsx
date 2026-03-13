'use client'

import dynamic from 'next/dynamic'
import { tokens } from '@/lib/design-tokens'
import { Box } from '../base'
import type { FilterConfig, SavedFilter } from '../premium/AdvancedFilter'

const MobileFilterSheet = dynamic(() => import('../ranking/MobileFilterSheet'), { ssr: false })
const AdvancedFilter = dynamic(() => import('../premium/AdvancedFilter'), {
  ssr: false,
  loading: () => (
    <Box style={{ padding: tokens.spacing[3], background: 'var(--color-bg-secondary)', borderRadius: tokens.radius.md }}>
      <Box className="skeleton" style={{ height: 40, borderRadius: tokens.radius.sm }} />
    </Box>
  ),
})

interface AdvancedFilterPanelProps {
  showAdvancedFilter: boolean
  showMobileFilter: boolean
  onCloseMobileFilter: () => void
  filterConfig: FilterConfig
  savedFilters: SavedFilter[]
  onFilterChange: (config: FilterConfig) => void
  onSaveFilter: (name: string, description?: string) => void | Promise<void>
  onLoadFilter: (filter: SavedFilter) => void
  onDeleteFilter: (filterId: string) => void | Promise<void>
  hasActiveFilters: boolean
  isPro: boolean
}

export default function AdvancedFilterPanel({
  showAdvancedFilter,
  showMobileFilter,
  onCloseMobileFilter,
  filterConfig,
  savedFilters,
  onFilterChange,
  onSaveFilter,
  onLoadFilter,
  onDeleteFilter,
  hasActiveFilters,
  isPro,
}: AdvancedFilterPanelProps) {
  return (
    <>
      {/* 高级筛选面板 */}
      {showAdvancedFilter && (
        <Box style={{ marginBottom: tokens.spacing[2] }}>
          <AdvancedFilter
            currentFilter={filterConfig}
            savedFilters={savedFilters}
            onFilterChange={onFilterChange}
            onSaveFilter={onSaveFilter}
            onLoadFilter={onLoadFilter}
            onDeleteFilter={onDeleteFilter}
            isPro={isPro}
          />
        </Box>
      )}

      {/* Mobile filter bottom sheet */}
      <MobileFilterSheet
        open={showMobileFilter}
        onClose={onCloseMobileFilter}
        filterConfig={filterConfig}
        onFilterChange={onFilterChange}
        onReset={() => onFilterChange({})}
        hasActiveFilters={hasActiveFilters}
      />
    </>
  )
}
