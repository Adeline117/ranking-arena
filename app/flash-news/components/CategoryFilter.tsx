'use client'

import { localizedLabel } from '@/lib/utils/format'
import { tokens } from '@/lib/design-tokens'
import { Box } from '@/app/components/base'

interface CategoryOption {
  key: string
  label: string
  label_en: string
}

interface CategoryFilterProps {
  categories: CategoryOption[]
  selectedCategory: string
  onCategoryChange: (category: string) => void
  language: string
}

export default function CategoryFilter({ categories, selectedCategory, onCategoryChange, language }: CategoryFilterProps) {
  return (
    <Box style={{ marginBottom: tokens.spacing[4], display: 'flex', flexWrap: 'wrap', gap: tokens.spacing[2] }}>
      {categories.map((cat) => {
        const isActive = selectedCategory === cat.key
        return (
          <button
            key={cat.key}
            className="filter-chip"
            data-active={isActive ? 'true' : undefined}
            onClick={() => onCategoryChange(cat.key)}
            style={{
              padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
              borderRadius: tokens.radius.lg,
              fontSize: tokens.typography.fontSize.sm,
              fontWeight: isActive ? tokens.typography.fontWeight.bold : tokens.typography.fontWeight.medium,
              background: isActive ? tokens.gradient.primary : tokens.glass.bg.light,
              backdropFilter: isActive ? 'none' : tokens.glass.blur.sm,
              WebkitBackdropFilter: isActive ? 'none' : tokens.glass.blur.sm,
              color: isActive ? 'var(--color-on-accent)' : tokens.colors.text.secondary,
              border: isActive ? 'none' : tokens.glass.border.light,
              cursor: 'pointer',
              transition: `all ${tokens.transition.base}`,
              boxShadow: isActive ? `0 4px 12px ${tokens.colors.accent.primary}40` : 'none',
              outline: 'none',
            }}
          >
            {localizedLabel(cat.label, cat.label_en, language)}
          </button>
        )
      })}
    </Box>
  )
}
