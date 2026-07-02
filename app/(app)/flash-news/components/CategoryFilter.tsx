'use client'

import { tokens, alpha } from '@/lib/design-tokens'
import { Box } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import type { TranslationKey } from '@/lib/i18n'

interface CategoryOption {
  key: string
}

interface CategoryFilterProps {
  categories: CategoryOption[]
  selectedCategory: string
  onCategoryChange: (category: string) => void
}

export default function CategoryFilter({
  categories,
  selectedCategory,
  onCategoryChange,
}: CategoryFilterProps) {
  const { t } = useLanguage()
  return (
    <Box
      role="group"
      aria-label={t('filterByCategory')}
      style={{
        marginBottom: tokens.spacing[4],
        display: 'flex',
        flexWrap: 'wrap',
        gap: tokens.spacing[2],
      }}
    >
      {categories.map((cat) => {
        const isActive = selectedCategory === cat.key
        return (
          <button
            key={cat.key}
            type="button"
            className="filter-chip"
            data-active={isActive ? 'true' : undefined}
            aria-pressed={isActive}
            onClick={() => onCategoryChange(cat.key)}
            style={{
              padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
              borderRadius: tokens.radius.lg,
              fontSize: tokens.typography.fontSize.sm,
              fontWeight: isActive
                ? tokens.typography.fontWeight.bold
                : tokens.typography.fontWeight.medium,
              background: isActive ? tokens.gradient.primary : tokens.glass.bg.light,
              backdropFilter: isActive ? 'none' : tokens.glass.blur.sm,
              WebkitBackdropFilter: isActive ? 'none' : tokens.glass.blur.sm,
              color: isActive ? 'var(--color-on-accent)' : tokens.colors.text.secondary,
              border: isActive ? 'none' : tokens.glass.border.light,
              cursor: 'pointer',
              transition: `all ${tokens.transition.base}`,
              boxShadow: isActive
                ? `0 4px 12px ${alpha(tokens.colors.accent.primary, 25)}`
                : 'none',
              outline: 'none',
            }}
          >
            {t(`newsFlash_cat_${cat.key}` as TranslationKey)}
          </button>
        )
      })}
    </Box>
  )
}
