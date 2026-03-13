'use client'

import { tokens } from '@/lib/design-tokens'
import { SearchIcon } from '../ui/icons'
import { useLanguage } from '../Providers/LanguageProvider'

export interface MobileSearchButtonProps {
  onOpen: () => void
}

export default function MobileSearchButton({ onOpen }: MobileSearchButtonProps) {
  const { t } = useLanguage()

  return (
    <button
      className="show-mobile-flex touch-target"
      aria-label={t('search')}
      onClick={onOpen}
      style={{
        alignItems: 'center',
        justifyContent: 'center',
        width: 44,
        height: 44,
        borderRadius: tokens.radius.full,
        background: `var(--color-accent-primary-12)`,
        color: 'var(--color-text-secondary)',
        transition: `all ${tokens.transition.base}`,
        border: `1px solid var(--color-accent-primary-30)`,
        cursor: 'pointer',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'var(--color-accent-primary-20)'
        e.currentTarget.style.color = 'var(--color-text-primary)'
        e.currentTarget.style.transform = 'scale(1.05)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'var(--color-accent-primary-12)'
        e.currentTarget.style.color = 'var(--color-text-secondary)'
        e.currentTarget.style.transform = 'scale(1)'
      }}
    >
      <SearchIcon size={20} />
    </button>
  )
}
