import React from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box } from '../../base'
import { Skeleton, SkeletonAvatar, RankingSkeleton } from '../Skeleton'
import { PageShell } from './PageShell'

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

// -- Rankings page skeleton ---------------------------------------------------

export function RankingsPageSkeleton() {
  return (
    <PageShell>
      <Skeleton width="200px" height="28px" style={{ marginBottom: tokens.spacing[4] }} />
      {/* Tab filters */}
      <div style={{ display: 'flex', gap: tokens.spacing[2], marginBottom: tokens.spacing[4] }}>
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} width="80px" height="36px" variant="rounded" />
        ))}
      </div>
      <RankingSkeleton />
    </PageShell>
  )
}

// -- Portfolio page skeleton --------------------------------------------------

export function PortfolioPageSkeleton() {
  return (
    <PageShell>
      <Skeleton width="140px" height="28px" style={{ marginBottom: tokens.spacing[5] }} />
      {/* Stats cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: tokens.spacing[4], marginBottom: tokens.spacing[6] }}>
        {Array.from({ length: 4 }).map((_, i) => (
          <Box key={i} className="glass-card" p={4} radius="xl" style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
            <Skeleton width="80px" height="12px" />
            <Skeleton width="120px" height="28px" />
          </Box>
        ))}
      </div>
      {/* Chart */}
      <Box className="glass-card" p={4} radius="xl" style={{ marginBottom: tokens.spacing[4] }}>
        <Skeleton width="100%" height="240px" variant="rounded" />
      </Box>
      {/* Table */}
      <Box className="glass-card" p={4} radius="xl">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: `${tokens.spacing[3]} 0`, borderBottom: `1px solid ${tokens.colors.border.primary}20` }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
              <SkeletonAvatar size={32} />
              <Skeleton width="100px" height="14px" />
            </div>
            <Skeleton width="80px" height="14px" />
            <Skeleton width="60px" height="14px" />
          </div>
        ))}
      </Box>
    </PageShell>
  )
}

// -- Pricing page skeleton ----------------------------------------------------

export function PricingPageSkeleton() {
  return (
    <PageShell>
      <div style={{ maxWidth: 960, margin: '0 auto' }}>
        <Skeleton width="200px" height="32px" style={{ margin: '0 auto', marginBottom: tokens.spacing[6] }} />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: tokens.spacing[4] }}>
          {Array.from({ length: 3 }).map((_, i) => (
            <Box key={i} className="glass-card" p={6} radius="xl" style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[4] }}>
              <Skeleton width="100px" height="20px" />
              <Skeleton width="140px" height="36px" />
              <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
                {Array.from({ length: 4 }).map((_, j) => (
                  <Skeleton key={j} width="80%" height="14px" />
                ))}
              </div>
              <Skeleton width="100%" height="44px" variant="rounded" style={{ marginTop: 'auto' }} />
            </Box>
          ))}
        </div>
      </div>
    </PageShell>
  )
}

// -- Membership page skeleton -------------------------------------------------

export function MembershipPageSkeleton() {
  return (
    <PageShell>
      <Skeleton width="160px" height="28px" style={{ margin: '0 auto', marginBottom: tokens.spacing[5] }} />
      {/* Current plan */}
      <Box className="glass-card" p={5} radius="xl" style={{ marginBottom: tokens.spacing[6], display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <Skeleton width="120px" height="20px" style={{ marginBottom: 8 }} />
          <Skeleton width="200px" height="14px" />
        </div>
        <Skeleton width="120px" height="40px" variant="rounded" />
      </Box>
      {/* Plan cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: tokens.spacing[4] }}>
        {Array.from({ length: 3 }).map((_, i) => (
          <Box key={i} className="glass-card" p={6} radius="xl" style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
            <Skeleton width="80px" height="18px" />
            <Skeleton width="120px" height="32px" />
            {Array.from({ length: 4 }).map((_, j) => (
              <Skeleton key={j} width="80%" height="14px" />
            ))}
            <Skeleton width="100%" height="44px" variant="rounded" style={{ marginTop: tokens.spacing[2] }} />
          </Box>
        ))}
      </div>
    </PageShell>
  )
}

// -- Trader profile page skeleton ---------------------------------------------

export function TraderProfilePageSkeleton() {
  return (
    <PageShell>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[4], marginBottom: tokens.spacing[6] }}>
        <SkeletonAvatar size={80} />
        <div style={{ flex: 1 }}>
          <Skeleton width="200px" height="24px" style={{ marginBottom: 8 }} />
          <Skeleton width="120px" height="16px" />
        </div>
      </div>
      {/* Tabs */}
      <div style={{ display: 'flex', gap: tokens.spacing[4], marginBottom: tokens.spacing[6], borderBottom: `1px solid ${tokens.colors.border.primary}`, paddingBottom: tokens.spacing[3] }}>
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} width="80px" height="20px" />
        ))}
      </div>
      {/* Stats grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: tokens.spacing[3], marginBottom: tokens.spacing[6] }}>
        {Array.from({ length: 4 }).map((_, i) => (
          <Box key={i} className="glass-card" p={4} radius="xl" style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2], alignItems: 'center' }}>
            <Skeleton width="50px" height="24px" />
            <Skeleton width="40px" height="10px" />
          </Box>
        ))}
      </div>
      {/* Chart */}
      <Box className="glass-card" p={4} radius="xl">
        <Skeleton width="100%" height="200px" variant="rounded" />
      </Box>
    </PageShell>
  )
}
