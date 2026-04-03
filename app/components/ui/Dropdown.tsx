'use client'

/**
 * Dropdown Component
 *
 * Accessible dropdown/select component with keyboard navigation
 * Supports arrow keys, Enter, Escape, Home, End, and type-ahead search
 * Auto-shows search input when options > 8
 */

import React, { useState, useRef, useEffect, useCallback, useId } from 'react'
import { tokens } from '@/lib/design-tokens'
import { useKeyboardNavigation } from '@/lib/hooks/useKeyboardNavigation'

export interface DropdownOption<T = string> {
  value: T
  label: string
  icon?: React.ReactNode
  disabled?: boolean
}

export interface DropdownProps<T = string> {
  options: DropdownOption<T>[]
  value: T
  onChange: (value: T) => void
  placeholder?: string
  label?: string
  disabled?: boolean
  error?: boolean | string
  size?: 'sm' | 'md' | 'lg'
  fullWidth?: boolean
  className?: string
  style?: React.CSSProperties
  renderOption?: (option: DropdownOption<T>, isActive: boolean, isSelected: boolean) => React.ReactNode
  /** Force show/hide search input (auto-shown when options > 8) */
  searchable?: boolean
}

export function Dropdown<T = string>({
  options,
  value,
  onChange,
  placeholder = 'Select...',
  label,
  disabled = false,
  error = false,
  size = 'md',
  fullWidth = false,
  className,
  style,
  renderOption,
  searchable,
}: DropdownProps<T>) {
  const [isOpen, setIsOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const containerRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const instanceId = useId()

  const listId = `dropdown-list-${instanceId}`
  const errorId = `dropdown-error-${instanceId}`

  const selectedOption = options.find((opt) => opt.value === value)
  const hasError = Boolean(error)
  const errorMessage = typeof error === 'string' ? error : undefined

  // Show search when explicitly enabled or when many options
  const showSearch = searchable ?? options.length > 8

  // Filter options by search query
  const filteredOptions = showSearch && searchQuery
    ? options.filter((opt) =>
        opt.label.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : options

  const handleSelect = useCallback((option: DropdownOption<T>) => {
    if (!option.disabled) {
      onChange(option.value)
      setIsOpen(false)
      setSearchQuery('')
      buttonRef.current?.focus()
    }
  }, [onChange])

  const handleOpen = useCallback(() => {
    setIsOpen(true)
    setSearchQuery('')
    // Focus search input when opening if searchable
    if (showSearch) {
      requestAnimationFrame(() => {
        searchInputRef.current?.focus()
      })
    }
  }, [showSearch])

  const { activeIndex, handleKeyDown, resetActiveIndex } = useKeyboardNavigation({
    items: filteredOptions,
    isOpen,
    onSelect: handleSelect,
    onClose: () => {
      setIsOpen(false)
      setSearchQuery('')
      buttonRef.current?.focus()
    },
    getItemLabel: (opt) => opt.label,
    loop: true,
    typeAhead: !showSearch, // Disable type-ahead when search input is active
  })

  // Click outside to close
  useEffect(() => {
    if (!isOpen) return

    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false)
        setSearchQuery('')
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [isOpen])

  // Scroll active item into view
  useEffect(() => {
    if (isOpen && activeIndex >= 0 && listRef.current) {
      const activeItem = listRef.current.children[activeIndex] as HTMLElement
      if (activeItem) {
        activeItem.scrollIntoView({ block: 'nearest' })
      }
    }
  }, [isOpen, activeIndex])

  const sizeStyles = {
    sm: {
      padding: `${tokens.spacing[1]} ${tokens.spacing[3]}`,
      fontSize: tokens.typography.fontSize.sm,
      minHeight: 44,
    },
    md: {
      padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
      fontSize: tokens.typography.fontSize.base,
      minHeight: 44,
    },
    lg: {
      padding: `${tokens.spacing[3]} ${tokens.spacing[5]}`,
      fontSize: tokens.typography.fontSize.md,
      minHeight: 48,
    },
  }

  const listItemSizeStyles = {
    sm: { padding: `${tokens.spacing[2]} ${tokens.spacing[3]}` },
    md: { padding: `${tokens.spacing[2]} ${tokens.spacing[4]}` },
    lg: { padding: `${tokens.spacing[3]} ${tokens.spacing[5]}` },
  }

  return (
    <div
      ref={containerRef}
      className={className}
      style={{
        position: 'relative',
        width: fullWidth ? '100%' : 'auto',
        ...style,
      }}
    >
      {label && (
        <label
          style={{
            display: 'block',
            marginBottom: tokens.spacing[1],
            fontSize: tokens.typography.fontSize.sm,
            fontWeight: tokens.typography.fontWeight.medium,
            color: tokens.colors.text.secondary,
          }}
        >
          {label}
        </label>
      )}

      <button
        ref={buttonRef}
        type="button"
        role="combobox"
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        aria-controls={listId}
        aria-invalid={hasError}
        aria-describedby={errorMessage ? errorId : undefined}
        disabled={disabled}
        onClick={() => {
          if (disabled) return
          if (isOpen) {
            setIsOpen(false)
            setSearchQuery('')
          } else {
            handleOpen()
          }
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            if (!isOpen) {
              handleOpen()
            } else {
              handleKeyDown(e)
            }
          } else if (isOpen) {
            handleKeyDown(e)
          } else if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            handleOpen()
          }
        }}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: tokens.spacing[2],
          width: '100%',
          ...sizeStyles[size],
          background: tokens.glass.bg.light,
          backdropFilter: tokens.glass.blur.sm,
          WebkitBackdropFilter: tokens.glass.blur.sm,
          border: hasError
            ? `2px solid ${tokens.colors.accent.error}`
            : `1px solid ${tokens.colors.border.primary}`,
          borderRadius: tokens.radius.lg,
          color: selectedOption ? tokens.colors.text.primary : tokens.colors.text.tertiary,
          cursor: disabled ? 'not-allowed' : 'pointer',
          fontFamily: tokens.typography.fontFamily.sans.join(', '),
          fontWeight: tokens.typography.fontWeight.medium,
          opacity: disabled ? 0.5 : 1,
          transition: tokens.transition.fast,
          outline: 'none',
        }}
        className="focus-visible:ring-2 focus-visible:ring-offset-2"
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {selectedOption ? (
            <span style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
              {selectedOption.icon}
              {selectedOption.label}
            </span>
          ) : (
            placeholder
          )}
        </span>

        {/* Chevron icon */}
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{
            flexShrink: 0,
            transition: tokens.transition.fast,
            transform: isOpen ? 'rotate(180deg)' : 'rotate(0deg)',
          }}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {/* Dropdown list */}
      {isOpen && (
        <div
          className="dropdown-enter"
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            right: 0,
            marginTop: tokens.spacing[1],
            background: tokens.glass.bg.secondary,
            backdropFilter: tokens.glass.blur.xl,
            WebkitBackdropFilter: tokens.glass.blur.xl,
            border: tokens.glass.border.light,
            borderRadius: tokens.radius.lg,
            boxShadow: tokens.shadow.xl,
            zIndex: tokens.zIndex.dropdown,
            overflow: 'hidden',
          }}
        >
          {/* Search input for long lists */}
          {showSearch && (
            <div style={{ padding: `${tokens.spacing[2]} ${tokens.spacing[2]} 0` }}>
              <input
                ref={searchInputRef}
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  // Allow Escape and arrow keys to propagate to keyboard navigation
                  if (e.key === 'Escape') {
                    setIsOpen(false)
                    setSearchQuery('')
                    buttonRef.current?.focus()
                  } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                    e.preventDefault()
                    handleKeyDown(e)
                  } else if (e.key === 'Enter') {
                    e.preventDefault()
                    if (filteredOptions.length > 0) {
                      const target = activeIndex >= 0 ? filteredOptions[activeIndex] : filteredOptions[0]
                      if (target && !target.disabled) handleSelect(target)
                    }
                  }
                }}
                placeholder="Search..."
                style={{
                  width: '100%',
                  padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                  background: 'var(--glass-bg-light)',
                  border: `1px solid ${tokens.colors.border.primary}`,
                  borderRadius: tokens.radius.md,
                  color: tokens.colors.text.primary,
                  fontSize: tokens.typography.fontSize.sm,
                  outline: 'none',
                }}
              />
            </div>
          )}

          <ul
            ref={listRef}
            id={listId}
            role="listbox"
            aria-label={label || 'Options'}
            style={{
              padding: tokens.spacing[1],
              maxHeight: 'min(300px, 50vh)',
              overflowY: 'auto',
              listStyle: 'none',
              margin: 0,
            }}
          >
            {filteredOptions.length === 0 && searchQuery && (
              <li
                style={{
                  ...listItemSizeStyles[size],
                  color: tokens.colors.text.tertiary,
                  textAlign: 'center',
                }}
              >
                No matches
              </li>
            )}
            {filteredOptions.map((option, index) => {
              const isActive = index === activeIndex
              const isSelected = option.value === value
              const isDisabled = option.disabled

              if (renderOption) {
                return (
                  <li
                    key={String(option.value)}
                    role="option"
                    aria-selected={isSelected}
                    aria-disabled={isDisabled}
                  >
                    {renderOption(option, isActive, isSelected)}
                  </li>
                )
              }

              return (
                <li
                  key={String(option.value)}
                  role="option"
                  aria-selected={isSelected}
                  aria-disabled={isDisabled}
                  onClick={() => !isDisabled && handleSelect(option)}
                  onMouseEnter={() => !isDisabled && resetActiveIndex()}
                  style={{
                    ...listItemSizeStyles[size],
                    display: 'flex',
                    alignItems: 'center',
                    gap: tokens.spacing[2],
                    borderRadius: tokens.radius.md,
                    cursor: isDisabled ? 'not-allowed' : 'pointer',
                    color: isDisabled
                      ? tokens.colors.text.disabled
                      : isSelected
                      ? tokens.colors.accent.brand
                      : tokens.colors.text.primary,
                    background: isActive
                      ? tokens.colors.bg.hover
                      : isSelected
                      ? `${tokens.colors.accent.brand}15`
                      : 'transparent',
                    fontWeight: isSelected
                      ? tokens.typography.fontWeight.semibold
                      : tokens.typography.fontWeight.medium,
                    opacity: isDisabled ? 0.5 : 1,
                    transition: tokens.transition.fast,
                  }}
                >
                  {option.icon}
                  <span style={{ flex: 1 }}>{option.label}</span>
                  {isSelected && (
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  )}
                </li>
              )
            })}
          </ul>
        </div>
      )}

      {/* Error message */}
      {errorMessage && (
        <p
          id={errorId}
          role="alert"
          style={{
            marginTop: tokens.spacing[1],
            fontSize: tokens.typography.fontSize.sm,
            color: tokens.colors.accent.error,
          }}
        >
          {errorMessage}
        </p>
      )}
    </div>
  )
}

export default Dropdown
