'use client'

import { useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text, Button } from '../base'
import { useLanguage } from '../Providers/LanguageProvider'

export interface SearchFilters {
  type: 'all' | 'traders' | 'posts' | 'users'
  exchange?: string
  minRoi?: number
  maxRoi?: number
  minFollowers?: number
  timeRange: '1d' | '7d' | '30d' | '90d' | 'all'
  sortBy: 'relevance' | 'roi' | 'pnl' | 'followers' | 'date'
}

interface AdvancedFiltersProps {
  filters: SearchFilters
  onChange: (filters: SearchFilters) => void
  onClose?: () => void
}

const EXCHANGES = [
  { value: '', label: 'All Exchanges' },
  { value: 'binance', label: 'Binance' },
  { value: 'bybit', label: 'Bybit' },
  { value: 'bitget', label: 'Bitget' },
  { value: 'okx', label: 'OKX' },
  { value: 'gmx', label: 'GMX' },
  { value: 'dydx', label: 'dYdX' },
]

const TIME_RANGES = [
  { value: 'all', label: 'All Time' },
  { value: '1d', label: 'Last 24 Hours' },
  { value: '7d', label: 'Last 7 Days' },
  { value: '30d', label: 'Last 30 Days' },
  { value: '90d', label: 'Last 90 Days' },
]

const SORT_OPTIONS = [
  { value: 'relevance', label: 'Relevance' },
  { value: 'roi', label: 'ROI (High to Low)' },
  { value: 'pnl', label: 'PnL (High to Low)' },
  { value: 'followers', label: 'Followers (High to Low)' },
  { value: 'date', label: 'Most Recent' },
]

const SEARCH_TYPES = [
  { value: 'all', label: 'All Results' },
  { value: 'traders', label: 'Traders Only' },
  { value: 'posts', label: 'Posts Only' },
  { value: 'users', label: 'Users Only' },
]

export default function AdvancedFilters({
  filters,
  onChange,
  onClose,
}: AdvancedFiltersProps) {
  const { t } = useLanguage()
  const [localFilters, setLocalFilters] = useState<SearchFilters>(filters)
  const [hasChanges, setHasChanges] = useState(false)

  const handleChange = (key: keyof SearchFilters, value: any) => {
    setLocalFilters(prev => ({ ...prev, [key]: value }))
    setHasChanges(true)
  }

  const handleApply = () => {
    onChange(localFilters)
    setHasChanges(false)
    if (onClose) onClose()
  }

  const handleReset = () => {
    const defaultFilters: SearchFilters = {
      type: 'all',
      exchange: undefined,
      minRoi: undefined,
      maxRoi: undefined,
      minFollowers: undefined,
      timeRange: 'all',
      sortBy: 'relevance',
    }
    setLocalFilters(defaultFilters)
    onChange(defaultFilters)
    setHasChanges(false)
  }

  return (
    <Box
      style={{
        padding: tokens.spacing[4],
        background: tokens.colors.bg.secondary,
        borderRadius: tokens.radius.lg,
        border: `1px solid ${tokens.colors.border.primary}`,
      }}
    >
      <Box style={{ marginBottom: tokens.spacing[4] }}>
        <Text size="lg" weight="bold">
          {t('advancedFilters') || 'Advanced Filters'}
        </Text>
      </Box>

      <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[4] }}>
        {/* Search Type */}
        <Box>
          <Text size="sm" weight="bold" style={{ marginBottom: tokens.spacing[2] }}>
            {t('searchType') || 'Search Type'}
          </Text>
          <Box style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: tokens.spacing[2] }}>
            {SEARCH_TYPES.map(option => (
              <button
                key={option.value}
                onClick={() => handleChange('type', option.value)}
                style={{
                  padding: tokens.spacing[2],
                  background:
                    localFilters.type === option.value
                      ? tokens.colors.accent.primary
                      : tokens.colors.bg.tertiary,
                  border: `1px solid ${
                    localFilters.type === option.value
                      ? tokens.colors.accent.primary
                      : tokens.colors.border.primary
                  }`,
                  borderRadius: tokens.radius.md,
                  color:
                    localFilters.type === option.value
                      ? '#000'
                      : tokens.colors.text.primary,
                  fontSize: '13px',
                  fontWeight: localFilters.type === option.value ? 600 : 400,
                  cursor: 'pointer',
                  transition: 'all 0.2s',
                }}
              >
                {option.label}
              </button>
            ))}
          </Box>
        </Box>

        {/* Exchange Filter (for traders) */}
        {(localFilters.type === 'all' || localFilters.type === 'traders') && (
          <Box>
            <Text size="sm" weight="bold" style={{ marginBottom: tokens.spacing[2] }}>
              {t('exchange') || 'Exchange'}
            </Text>
            <select
              value={localFilters.exchange || ''}
              onChange={e => handleChange('exchange', e.target.value || undefined)}
              style={{
                width: '100%',
                padding: tokens.spacing[2],
                background: tokens.colors.bg.tertiary,
                border: `1px solid ${tokens.colors.border.primary}`,
                borderRadius: tokens.radius.md,
                color: tokens.colors.text.primary,
                fontSize: '14px',
              }}
            >
              {EXCHANGES.map(ex => (
                <option key={ex.value} value={ex.value}>
                  {ex.label}
                </option>
              ))}
            </select>
          </Box>
        )}

        {/* ROI Range (for traders) */}
        {(localFilters.type === 'all' || localFilters.type === 'traders') && (
          <Box>
            <Text size="sm" weight="bold" style={{ marginBottom: tokens.spacing[2] }}>
              {t('roiRange') || 'ROI Range (%)'}
            </Text>
            <Box style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', gap: tokens.spacing[2], alignItems: 'center' }}>
              <input
                type="number"
                placeholder="Min"
                value={localFilters.minRoi || ''}
                onChange={e => handleChange('minRoi', e.target.value ? parseFloat(e.target.value) : undefined)}
                style={{
                  padding: tokens.spacing[2],
                  background: tokens.colors.bg.tertiary,
                  border: `1px solid ${tokens.colors.border.primary}`,
                  borderRadius: tokens.radius.md,
                  color: tokens.colors.text.primary,
                  fontSize: '14px',
                }}
              />
              <Text size="sm" color="tertiary">
                to
              </Text>
              <input
                type="number"
                placeholder="Max"
                value={localFilters.maxRoi || ''}
                onChange={e => handleChange('maxRoi', e.target.value ? parseFloat(e.target.value) : undefined)}
                style={{
                  padding: tokens.spacing[2],
                  background: tokens.colors.bg.tertiary,
                  border: `1px solid ${tokens.colors.border.primary}`,
                  borderRadius: tokens.radius.md,
                  color: tokens.colors.text.primary,
                  fontSize: '14px',
                }}
              />
            </Box>
          </Box>
        )}

        {/* Min Followers (for traders) */}
        {(localFilters.type === 'all' || localFilters.type === 'traders') && (
          <Box>
            <Text size="sm" weight="bold" style={{ marginBottom: tokens.spacing[2] }}>
              {t('minFollowers') || 'Minimum Followers'}
            </Text>
            <input
              type="number"
              placeholder="e.g., 100"
              value={localFilters.minFollowers || ''}
              onChange={e => handleChange('minFollowers', e.target.value ? parseInt(e.target.value) : undefined)}
              style={{
                width: '100%',
                padding: tokens.spacing[2],
                background: tokens.colors.bg.tertiary,
                border: `1px solid ${tokens.colors.border.primary}`,
                borderRadius: tokens.radius.md,
                color: tokens.colors.text.primary,
                fontSize: '14px',
              }}
            />
          </Box>
        )}

        {/* Time Range (for posts) */}
        {(localFilters.type === 'all' || localFilters.type === 'posts') && (
          <Box>
            <Text size="sm" weight="bold" style={{ marginBottom: tokens.spacing[2] }}>
              {t('timeRange') || 'Time Range'}
            </Text>
            <Box style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: tokens.spacing[2] }}>
              {TIME_RANGES.map(option => (
                <button
                  key={option.value}
                  onClick={() => handleChange('timeRange', option.value)}
                  style={{
                    padding: tokens.spacing[2],
                    background:
                      localFilters.timeRange === option.value
                        ? tokens.colors.accent.primary
                        : tokens.colors.bg.tertiary,
                    border: `1px solid ${
                      localFilters.timeRange === option.value
                        ? tokens.colors.accent.primary
                        : tokens.colors.border.primary
                    }`,
                    borderRadius: tokens.radius.md,
                    color:
                      localFilters.timeRange === option.value
                        ? '#000'
                        : tokens.colors.text.primary,
                    fontSize: '13px',
                    fontWeight: localFilters.timeRange === option.value ? 600 : 400,
                    cursor: 'pointer',
                    transition: 'all 0.2s',
                  }}
                >
                  {option.label}
                </button>
              ))}
            </Box>
          </Box>
        )}

        {/* Sort By */}
        <Box>
          <Text size="sm" weight="bold" style={{ marginBottom: tokens.spacing[2] }}>
            {t('sortBy') || 'Sort By'}
          </Text>
          <select
            value={localFilters.sortBy}
            onChange={e => handleChange('sortBy', e.target.value)}
            style={{
              width: '100%',
              padding: tokens.spacing[2],
              background: tokens.colors.bg.tertiary,
              border: `1px solid ${tokens.colors.border.primary}`,
              borderRadius: tokens.radius.md,
              color: tokens.colors.text.primary,
              fontSize: '14px',
            }}
          >
            {SORT_OPTIONS.map(option => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </Box>

        {/* Action Buttons */}
        <Box style={{ display: 'flex', gap: tokens.spacing[2], marginTop: tokens.spacing[2] }}>
          <Button
            variant="secondary"
            size="sm"
            onClick={handleReset}
            fullWidth
          >
            {t('reset') || 'Reset'}
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={handleApply}
            disabled={!hasChanges}
            fullWidth
          >
            {t('applyFilters') || 'Apply Filters'}
          </Button>
        </Box>
      </Box>
    </Box>
  )
}
