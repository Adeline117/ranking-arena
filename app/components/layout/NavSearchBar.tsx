'use client'

import React from 'react'
import dynamic from 'next/dynamic'
import { tokens } from '@/lib/design-tokens'
import { Box } from '../base'
import { SearchIcon } from '../ui/icons'
import { useLanguage } from '../Providers/LanguageProvider'

const SearchDropdown = dynamic(() => import('../search/SearchDropdown'), { ssr: false })

export interface NavSearchBarProps {
  searchRef: React.RefObject<HTMLDivElement | null>
  searchQuery: string
  setSearchQuery: (query: string) => void
  showSearchDropdown: boolean
  setShowSearchDropdown: (show: boolean) => void
  onSearch: (e: React.FormEvent) => void
}

export default function NavSearchBar({
  searchRef,
  searchQuery,
  setSearchQuery,
  showSearchDropdown,
  setShowSearchDropdown,
  onSearch,
}: NavSearchBarProps) {
  const { t } = useLanguage()

  return (
    <div
      ref={searchRef}
      className="top-nav-search hide-mobile"
      style={{
        flex: 1,
        display: 'flex',
        justifyContent: 'center',
        maxWidth: 600,
        position: 'relative',
      }}
    >
      <form onSubmit={onSearch} role="search" style={{ width: '100%', position: 'relative' }}>
        <input
          type="search"
          className="top-nav-search-input"
          placeholder={`${t('searchPlaceholder')} ⌘K`}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          aria-label={t('searchTraders')}
          aria-expanded={showSearchDropdown}
          aria-haspopup="listbox"
          aria-controls="search-dropdown-listbox"
          aria-autocomplete="list"
          role="combobox"
          tabIndex={0}
          style={{
            width: '100%',
            height: 44,
            borderRadius: tokens.radius.full,
            border: tokens.glass.border.light,
            background: tokens.glass.bg.light,
            backdropFilter: tokens.glass.blur.sm,
            WebkitBackdropFilter: tokens.glass.blur.sm,
            color: 'var(--color-text-primary)',
            padding: `0 ${tokens.spacing[4]} 0 40px`,
            outline: 'none',
            fontWeight: tokens.typography.fontWeight.medium,
            fontSize: tokens.typography.fontSize.sm,
            fontFamily: tokens.typography.fontFamily.sans.join(', '),
            transition: `all ${tokens.transition.base}`,
            boxShadow: tokens.shadow.inner,
          }}
          onFocus={(e) => {
            setShowSearchDropdown(true)
            e.currentTarget.style.border = '1px solid var(--color-accent-primary)'
            e.currentTarget.style.boxShadow = '0 0 0 2px var(--color-accent-primary-20)'
          }}
          onBlur={(e) => {
            e.currentTarget.style.border = tokens.glass.border.light
            e.currentTarget.style.boxShadow = tokens.shadow.inner
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              onSearch(e)
            } else if (e.key === 'Escape') {
              setShowSearchDropdown(false)
              e.currentTarget.blur()
            }
          }}
        />
        <Box
          style={{
            position: 'absolute',
            left: tokens.spacing[3],
            top: '50%',
            transform: 'translateY(-50%)',
            color: 'var(--color-text-tertiary)',
            display: 'flex',
            alignItems: 'center',
          }}
        >
          <SearchIcon size={16} />
        </Box>
      </form>
      <SearchDropdown open={showSearchDropdown} query={searchQuery} onClose={() => setShowSearchDropdown(false)} />
    </div>
  )
}
