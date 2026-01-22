'use client'

import { tokens } from '@/lib/design-tokens'

interface ToggleSwitchProps {
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
  size?: 'sm' | 'md'
}

export default function ToggleSwitch({ checked, onChange, disabled = false, size = 'md' }: ToggleSwitchProps) {
  const width = size === 'sm' ? 36 : 44
  const height = size === 'sm' ? 20 : 24
  const dotSize = size === 'sm' ? 16 : 20
  const dotOffset = 2

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => !disabled && onChange(!checked)}
      disabled={disabled}
      style={{
        position: 'relative',
        width,
        height,
        borderRadius: height / 2,
        border: 'none',
        background: checked
          ? tokens.gradient.primary
          : tokens.colors.bg.tertiary,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        transition: 'background 0.2s ease, box-shadow 0.2s ease',
        flexShrink: 0,
        boxShadow: checked ? `0 0 12px rgba(139, 111, 168, 0.3)` : 'inset 0 1px 3px rgba(0,0,0,0.2)',
        padding: 0,
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: dotOffset,
          left: checked ? width - dotSize - dotOffset : dotOffset,
          width: dotSize,
          height: dotSize,
          borderRadius: '50%',
          background: '#fff',
          transition: 'left 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
          boxShadow: '0 1px 3px rgba(0, 0, 0, 0.2)',
        }}
      />
    </button>
  )
}
