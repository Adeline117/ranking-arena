'use client'

import React from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box } from '../base'
import { Skeleton, SkeletonAvatar, SkeletonText } from './Skeleton'

/**
 * Reusable full-page skeleton layouts for route-level loading states.
 * Each variant matches the actual page layout it represents.
 */

// -- Shared wrapper ----------------------------------------------------------

function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      {/* TopNav placeholder */}
      <div style={{ height: 56, background: 'var(--glass-bg-primary)', borderBottom: `1px solid ${tokens.colors.border.primary}` }} />
      <main style={{ maxWidth: 1200, margin: '0 auto', padding: `${tokens.spacing[6]} ${tokens.spacing[4]}` }}>
        {children}
      </main>
    </div>
  )
}

// -- Market page skeleton -----------------------------------------------------

export function MarketPageSkeleton() {
  return (
    <PageShell>
      {/* Market overview bar */}
      <Skeleton width="100%" height="48px" variant="rounded" style={{ marginBottom: tokens.spacing[4] }} />

      {/* Page title */}
      <Skeleton width="120px" height="28px" style={{ marginBottom: tokens.spacing[4] }} />

      {/* Widget grid */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
        gap: tokens.spacing[4],
      }}>
        {Array.from({ length: 6 }).map((_, i) => (
          <Box
            key={i}
            className="glass-card"
            p={4}
            radius="xl"
            style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}
          >
            <Skeleton width="50%" height="18px" />
            <Skeleton width="100%" height="160px" variant="rounded" />
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <Skeleton width="60px" height="14px" />
              <Skeleton width="60px" height="14px" />
            </div>
          </Box>
        ))}
      </div>
    </PageShell>
  )
}

// -- Compare page skeleton ----------------------------------------------------

export function ComparePageSkeleton() {
  return (
    <PageShell>
      {/* Title + add button row */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: tokens.spacing[6] }}>
        <Skeleton width="180px" height="28px" />
        <Skeleton width="140px" height="40px" variant="rounded" />
      </div>

      {/* Trader comparison cards side by side */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
        gap: tokens.spacing[4],
      }}>
        {Array.from({ length: 3 }).map((_, i) => (
          <Box
            key={i}
            className="glass-card"
            p={5}
            radius="xl"
            style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[4] }}
          >
            {/* Trader header */}
            <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3] }}>
              <SkeletonAvatar size={48} />
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: tokens.spacing[1] }}>
                <Skeleton width="100px" height="18px" />
                <Skeleton width="70px" height="12px" />
              </div>
            </div>

            {/* Stats rows */}
            {Array.from({ length: 5 }).map((_, j) => (
              <div key={j} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <Skeleton width="80px" height="14px" />
                <Skeleton width="60px" height="14px" />
              </div>
            ))}

            {/* Mini chart */}
            <Skeleton width="100%" height="80px" variant="rounded" />
          </Box>
        ))}
      </div>
    </PageShell>
  )
}

// -- Settings page skeleton ---------------------------------------------------

export function SettingsPageSkeleton() {
  return (
    <PageShell>
      {/* Sidebar + content layout */}
      <div style={{ display: 'flex', gap: tokens.spacing[6] }}>
        {/* Section nav */}
        <div style={{ width: 200, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} width="100%" height="36px" variant="rounded" />
          ))}
        </div>

        {/* Form content */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: tokens.spacing[6] }}>
          {/* Profile section */}
          <Box className="glass-card" p={6} radius="xl" style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[5] }}>
            <Skeleton width="140px" height="24px" />

            {/* Avatar row */}
            <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[4] }}>
              <SkeletonAvatar size={72} />
              <Skeleton width="120px" height="36px" variant="rounded" />
            </div>

            {/* Form fields */}
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
                <Skeleton width="80px" height="14px" />
                <Skeleton width="100%" height="40px" variant="rounded" />
              </div>
            ))}

            {/* Save button */}
            <Skeleton width="100px" height="40px" variant="rounded" />
          </Box>
        </div>
      </div>
    </PageShell>
  )
}

// -- Library page skeleton (book card grid) -----------------------------------

export function LibraryPageSkeleton() {
  return (
    <PageShell>
      {/* Hero */}
      <Box
        className="glass-card"
        p={6}
        radius="xl"
        style={{ marginBottom: tokens.spacing[6] }}
      >
        <Skeleton width="200px" height="32px" style={{ marginBottom: 8 }} />
        <Skeleton width="350px" height="20px" style={{ marginBottom: 24 }} />
        <Skeleton width="100%" height="44px" style={{ maxWidth: 560 }} variant="rounded" />
      </Box>

      {/* Book grid */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
        gap: 20,
      }}>
        {Array.from({ length: 12 }).map((_, i) => (
          <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Skeleton width="100%" height="0" style={{ paddingBottom: '150%' }} variant="rounded" />
            <Skeleton width="80%" height="14px" />
            <Skeleton width="50%" height="12px" />
          </div>
        ))}
      </div>
    </PageShell>
  )
}

// -- Groups page skeleton (post feed) -----------------------------------------

export function GroupsPageSkeleton() {
  return (
    <PageShell>
      {/* Header row */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: tokens.spacing[6] }}>
        <Skeleton width="120px" height="32px" />
        <Skeleton width="120px" height="36px" variant="rounded" />
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: tokens.spacing[4], marginBottom: tokens.spacing[6], borderBottom: `1px solid ${tokens.colors.border.primary}`, paddingBottom: tokens.spacing[3] }}>
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} width="80px" height="20px" />
        ))}
      </div>

      {/* Group cards grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: tokens.spacing[4] }}>
        {Array.from({ length: 6 }).map((_, i) => (
          <Box key={i} style={{ borderRadius: tokens.radius.lg, background: tokens.colors.bg.secondary, overflow: 'hidden' }}>
            <Skeleton width="100%" height="120px" variant="rectangular" />
            <div style={{ padding: tokens.spacing[4], display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
              <Skeleton width="70%" height="20px" />
              <SkeletonText lines={2} />
              <div style={{ display: 'flex', gap: tokens.spacing[3], marginTop: tokens.spacing[2] }}>
                <Skeleton width="60px" height="14px" />
                <Skeleton width="60px" height="14px" />
              </div>
            </div>
          </Box>
        ))}
      </div>
    </PageShell>
  )
}

// -- User profile page skeleton -----------------------------------------------

export function UserProfilePageSkeleton() {
  return (
    <PageShell>
      {/* Profile header */}
      <Box
        className="glass-card"
        p={6}
        radius="xl"
        style={{ display: 'flex', alignItems: 'flex-start', gap: tokens.spacing[5], marginBottom: tokens.spacing[6] }}
      >
        <SkeletonAvatar size={72} />
        <div style={{ flex: 1 }}>
          <Skeleton width="160px" height="28px" style={{ marginBottom: 12 }} />
          <Skeleton width="240px" height="16px" style={{ marginBottom: 16 }} />
          <div style={{ display: 'flex', gap: tokens.spacing[4] }}>
            <Skeleton width="80px" height="20px" />
            <Skeleton width="80px" height="20px" />
          </div>
        </div>
      </Box>

      {/* Content + sidebar */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: tokens.spacing[6] }}>
        <Skeleton width="100%" height="400px" variant="rounded" />
        <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[6] }}>
          <Skeleton width="100%" height="150px" variant="rounded" />
          <Skeleton width="100%" height="150px" variant="rounded" />
        </div>
      </div>
    </PageShell>
  )
}
