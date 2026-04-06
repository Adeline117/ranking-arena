'use client'

import React from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '@/app/components/base'

export function ToggleSwitch({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      style={{
        width: 48,
        height: 26,
        borderRadius: 13,
        padding: 3,
        border: 'none',
        background: checked ? tokens.gradient.primary : tokens.colors.bg.tertiary,
        cursor: 'pointer',
        transition: `all ${tokens.transition.base}`,
        position: 'relative',
        flexShrink: 0,
        boxShadow: checked ? `${tokens.shadow.glow}, ${tokens.shadow.inner}` : tokens.shadow.inner,
        outline: 'none',
      }}
      onFocus={(e) => {
        e.currentTarget.style.boxShadow = `0 0 0 ${tokens.focusRing.width} ${tokens.focusRing.color}`
      }}
      onBlur={(e) => {
        e.currentTarget.style.boxShadow = checked ? `${tokens.shadow.glow}, ${tokens.shadow.inner}` : tokens.shadow.inner
      }}
    >
      <span
        style={{
          display: 'block',
          width: 20,
          height: 20,
          borderRadius: '50%',
          background: tokens.colors.white,
          transform: checked ? 'translateX(22px)' : 'translateX(0)',
          transition: `transform ${tokens.transition.bounce}`,
          boxShadow: tokens.shadow.sm,
        }}
      />
    </button>
  )
}

export function SectionCard({
  id,
  title,
  description,
  children,
  variant = 'default',
}: {
  id: string
  title: string
  description?: string
  children: React.ReactNode
  variant?: 'default' | 'danger'
}) {
  return (
    <Box
      id={id}
      style={{
        marginBottom: tokens.spacing[6],
        padding: tokens.spacing[6],
        borderRadius: tokens.radius['2xl'],
        background: tokens.glass.bg.secondary,
        backdropFilter: tokens.glass.blur.md,
        WebkitBackdropFilter: tokens.glass.blur.md,
        border: variant === 'danger' ? `1px solid ${tokens.colors.accent.error}30` : tokens.glass.border.light,
        boxShadow: variant === 'danger' ? tokens.shadow.glowError : tokens.shadow.md,
        transition: `all ${tokens.transition.base}`,
      }}
    >
      <Text
        size="lg"
        weight="black"
        style={{
          marginBottom: description ? tokens.spacing[1] : tokens.spacing[4],
          color: variant === 'danger' ? tokens.colors.accent.error : tokens.colors.text.primary,
          letterSpacing: '-0.2px',
        }}
      >
        {title}
      </Text>
      {description && (
        <Text size="sm" color="tertiary" style={{ marginBottom: tokens.spacing[4], lineHeight: tokens.typography.lineHeight.relaxed }}>
          {description}
        </Text>
      )}
      {children}
    </Box>
  )
}

export const SETTINGS_INPUT_CLASS = 'settings-input'

export function getInputStyle(hasError = false): React.CSSProperties {
  return {
    width: '100%',
    padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
    borderRadius: tokens.radius.lg,
    border: `1px solid ${hasError ? tokens.colors.accent.error : tokens.colors.border.primary}`,
    background: tokens.glass.bg.light,
    backdropFilter: tokens.glass.blur.xs,
    WebkitBackdropFilter: tokens.glass.blur.xs,
    color: tokens.colors.text.primary,
    fontSize: tokens.typography.fontSize.sm,
    fontWeight: tokens.typography.fontWeight.medium,
    outline: 'none',
    transition: `all ${tokens.transition.base}`,
    boxShadow: tokens.shadow.inner,
  }
}

export function RadioOption<T extends string>({
  name,
  value,
  currentValue,
  label,
  description,
  onChange,
}: {
  name: string
  value: T
  currentValue: T
  label: string
  description: string
  onChange: (v: T) => void
}) {
  return (
    <label
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: tokens.spacing[3],
        padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
        borderRadius: tokens.radius.md,
        cursor: 'pointer',
        transition: 'background 0.15s ease',
        background: currentValue === value ? `${tokens.colors.accent.primary}08` : 'transparent',
      }}
    >
      <input
        type="radio"
        name={name}
        value={value}
        checked={currentValue === value}
        onChange={() => onChange(value)}
        style={{ marginTop: 3, accentColor: tokens.colors.accent.brand }}
      />
      <Box>
        <Text size="sm" weight="medium">{label}</Text>
        {description && <Text size="xs" color="tertiary">{description}</Text>}
      </Box>
    </label>
  )
}

// Section IDs for navigation
export type SectionId = 'profile' | 'security' | 'wallet' | 'exchanges' | 'trader-links' | 'alerts' | 'notifications' | 'privacy' | 'account'

export const SECTION_ICONS: Record<SectionId, React.ReactNode> = {
  profile: (
    <svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  ),
  security: (
    <svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  ),
  wallet: (
    <svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <path d="M22 10H18a2 2 0 0 0-2 2 2 2 0 0 0 2 2h4" />
    </svg>
  ),
  exchanges: (
    <svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  ),
  'trader-links': (
    <svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <line x1="19" y1="8" x2="19" y2="14" />
      <line x1="22" y1="11" x2="16" y2="11" />
    </svg>
  ),
  alerts: (
    <svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
      <line x1="12" y1="2" x2="12" y2="4" />
    </svg>
  ),
  notifications: (
    <svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  ),
  privacy: (
    <svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  ),
  account: (
    <svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  ),
}

export const SECTION_KEYS: Record<SectionId, string> = {
  profile: 'profileSection',
  security: 'securitySection',
  wallet: 'walletSection',
  exchanges: 'exchangesSection',
  'trader-links': 'linkedAccountsSection',
  alerts: 'alertsSection',
  notifications: 'notificationsSection',
  privacy: 'privacySection',
  account: 'accountSection',
}

export const SECTION_IDS: SectionId[] = ['profile', 'security', 'wallet', 'exchanges', 'trader-links', 'alerts', 'notifications', 'privacy', 'account']
