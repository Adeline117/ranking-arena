'use client'

import React from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box } from '../base'
import { Skeleton, SkeletonAvatar, SkeletonText, RankingSkeleton } from './Skeleton'

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

// -- Notifications / Inbox page skeleton ------------------------------------

export function NotificationsPageSkeleton() {
  return (
    <PageShell>
      <Skeleton width="160px" height="28px" style={{ marginBottom: tokens.spacing[5] }} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
        {Array.from({ length: 8 }).map((_, i) => (
          <Box
            key={i}
            className="glass-card"
            p={3}
            radius="lg"
            style={{ display: 'flex', alignItems: 'flex-start', gap: tokens.spacing[3] }}
          >
            <SkeletonAvatar size={40} />
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
              <Skeleton width="80%" height="14px" />
              <Skeleton width="60%" height="12px" />
              <Skeleton width="40%" height="10px" />
            </div>
          </Box>
        ))}
      </div>
    </PageShell>
  )
}

// -- Messages page skeleton ---------------------------------------------------

export function MessagesPageSkeleton() {
  return (
    <PageShell>
      <Skeleton width="140px" height="28px" style={{ marginBottom: tokens.spacing[5] }} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
        {Array.from({ length: 6 }).map((_, i) => (
          <Box
            key={i}
            className="glass-card"
            p={4}
            radius="lg"
            style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3] }}
          >
            <SkeletonAvatar size={48} />
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: tokens.spacing[1] }}>
              <Skeleton width="120px" height="16px" />
              <Skeleton width="200px" height="12px" />
            </div>
            <Skeleton width="50px" height="12px" />
          </Box>
        ))}
      </div>
    </PageShell>
  )
}

// -- Conversation detail skeleton ---------------------------------------------

export function ConversationPageSkeleton() {
  return (
    <PageShell>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3], marginBottom: tokens.spacing[5], paddingBottom: tokens.spacing[4], borderBottom: `1px solid ${tokens.colors.border.primary}` }}>
        <SkeletonAvatar size={48} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[1] }}>
          <Skeleton width="120px" height="18px" />
          <Skeleton width="80px" height="12px" />
        </div>
      </div>
      {/* Messages */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[4] }}>
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} style={{ display: 'flex', gap: tokens.spacing[3], justifyContent: i % 2 === 0 ? 'flex-start' : 'flex-end' }}>
            {i % 2 === 0 && <SkeletonAvatar size={32} />}
            <Skeleton width={`${120 + Math.random() * 160}px`} height="40px" variant="rounded" />
          </div>
        ))}
      </div>
    </PageShell>
  )
}

// -- Flash news page skeleton -------------------------------------------------

export function FlashNewsPageSkeleton() {
  return (
    <PageShell>
      <div style={{ maxWidth: 680, margin: '0 auto' }}>
        <Skeleton width="160px" height="28px" style={{ marginBottom: tokens.spacing[5] }} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
          {Array.from({ length: 8 }).map((_, i) => (
            <Box
              key={i}
              className="glass-card"
              p={4}
              radius="lg"
              style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <Skeleton width="60px" height="12px" />
                <Skeleton width="40px" height="12px" />
              </div>
              <Skeleton width="90%" height="16px" />
              <Skeleton width="60%" height="14px" />
            </Box>
          ))}
        </div>
      </div>
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

// -- Post feed page skeleton (hot, following, my-posts) -----------------------

export function PostFeedPageSkeleton() {
  return (
    <PageShell>
      <Skeleton width="120px" height="28px" style={{ marginBottom: tokens.spacing[5] }} />
      <div style={{ maxWidth: 680, display: 'flex', flexDirection: 'column', gap: tokens.spacing[4] }}>
        {Array.from({ length: 4 }).map((_, i) => (
          <Box key={i} className="glass-card" p={4} radius="xl" style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3] }}>
              <SkeletonAvatar size={40} />
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: tokens.spacing[1] }}>
                <Skeleton width="100px" height="14px" />
                <Skeleton width="60px" height="10px" />
              </div>
            </div>
            <SkeletonText lines={3} />
            <div style={{ display: 'flex', gap: tokens.spacing[4], paddingTop: tokens.spacing[2] }}>
              <Skeleton width="50px" height="20px" />
              <Skeleton width="50px" height="20px" />
              <Skeleton width="50px" height="20px" />
            </div>
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

// -- Centered form skeleton (login, reset-password, etc.) ---------------------

export function CenteredFormSkeleton({ fields = 2 }: { fields?: number }) {
  return (
    <div style={{ minHeight: '100vh', background: tokens.colors.bg.primary, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <Box className="glass-card" p={6} radius="xl" style={{ width: '100%', maxWidth: 400, display: 'flex', flexDirection: 'column', gap: tokens.spacing[4], alignItems: 'center' }}>
        <SkeletonAvatar size={48} />
        <Skeleton width="160px" height="24px" />
        <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
          {Array.from({ length: fields }).map((_, i) => (
            <Skeleton key={i} width="100%" height="44px" variant="rounded" />
          ))}
        </div>
        <Skeleton width="100%" height="44px" variant="rounded" />
      </Box>
    </div>
  )
}

// -- Centered message skeleton (welcome, success, etc.) -----------------------

export function CenteredMessageSkeleton() {
  return (
    <div style={{ minHeight: '100vh', background: tokens.colors.bg.primary, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: tokens.spacing[3] }}>
        <SkeletonAvatar size={64} />
        <Skeleton width="200px" height="28px" />
        <Skeleton width="280px" height="16px" />
      </div>
    </div>
  )
}

// -- Status page skeleton -----------------------------------------------------

export function StatusPageSkeleton() {
  return (
    <PageShell>
      <div style={{ maxWidth: 800, margin: '0 auto' }}>
        <Skeleton width="160px" height="28px" style={{ marginBottom: tokens.spacing[6] }} />
        {Array.from({ length: 4 }).map((_, i) => (
          <Box key={i} className="glass-card" p={4} radius="lg" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: tokens.spacing[3] }}>
            <Skeleton width="140px" height="16px" />
            <Skeleton width="60px" height="24px" variant="rounded" />
          </Box>
        ))}
      </div>
    </PageShell>
  )
}

// -- Search page skeleton -----------------------------------------------------

export function SearchPageSkeleton() {
  return (
    <PageShell>
      <div style={{ maxWidth: 680, margin: '0 auto' }}>
        {/* Tab bar */}
        <div style={{ display: 'flex', gap: tokens.spacing[2], marginBottom: tokens.spacing[4] }}>
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} width={`${48 + Math.random() * 24}px`} height="36px" variant="rounded" />
          ))}
        </div>
        {/* Results */}
        <Box className="glass-card" radius="xl" style={{ overflow: 'hidden' }}>
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3], padding: tokens.spacing[4], borderBottom: `1px solid ${tokens.colors.border.primary}20` }}>
              <SkeletonAvatar size={44} />
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: tokens.spacing[1] }}>
                <Skeleton width={`${40 + i * 8}%`} height="14px" />
                <Skeleton width={`${25 + i * 5}%`} height="11px" />
              </div>
            </div>
          ))}
        </Box>
      </div>
    </PageShell>
  )
}

// -- Form page skeleton (kol apply, group apply, etc.) ------------------------

export function FormPageSkeleton() {
  return (
    <PageShell>
      <div style={{ maxWidth: 800, margin: '0 auto' }}>
        <Skeleton width="200px" height="32px" style={{ marginBottom: tokens.spacing[6] }} />
        <Box className="glass-card" p={6} radius="xl" style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[5] }}>
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
              <Skeleton width="100px" height="14px" />
              <Skeleton width="100%" height={i === 2 ? '120px' : '40px'} variant="rounded" />
            </div>
          ))}
          <Skeleton width="120px" height="40px" variant="rounded" />
        </Box>
      </div>
    </PageShell>
  )
}

// -- Admin page skeleton (table-based) ----------------------------------------

export function AdminPageSkeleton() {
  return (
    <PageShell>
      <Skeleton width="180px" height="28px" style={{ marginBottom: tokens.spacing[5] }} />
      {/* Filters */}
      <div style={{ display: 'flex', gap: tokens.spacing[3], marginBottom: tokens.spacing[4] }}>
        <Skeleton width="200px" height="36px" variant="rounded" />
        <Skeleton width="120px" height="36px" variant="rounded" />
      </div>
      {/* Table */}
      <Box className="glass-card" p={4} radius="xl">
        {/* Header row */}
        <div style={{ display: 'grid', gridTemplateColumns: '60px 1fr 120px 120px 100px', gap: tokens.spacing[3], padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`, marginBottom: tokens.spacing[2] }}>
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} width="70%" height="12px" />
          ))}
        </div>
        {/* Data rows */}
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} style={{ display: 'grid', gridTemplateColumns: '60px 1fr 120px 120px 100px', gap: tokens.spacing[3], padding: `${tokens.spacing[3]}`, borderTop: `1px solid ${tokens.colors.border.primary}15` }}>
            <Skeleton width="30px" height="14px" />
            <Skeleton width="80%" height="14px" />
            <Skeleton width="80px" height="14px" />
            <Skeleton width="60px" height="14px" />
            <Skeleton width="70px" height="24px" variant="rounded" />
          </div>
        ))}
      </Box>
    </PageShell>
  )
}

// -- Channels page skeleton ---------------------------------------------------

export function ChannelsPageSkeleton() {
  return (
    <PageShell>
      <Skeleton width="140px" height="28px" style={{ marginBottom: tokens.spacing[5] }} />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: tokens.spacing[4] }}>
        {Array.from({ length: 6 }).map((_, i) => (
          <Box key={i} className="glass-card" p={4} radius="xl" style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3] }}>
              <SkeletonAvatar size={48} />
              <div style={{ flex: 1 }}>
                <Skeleton width="70%" height="16px" />
                <Skeleton width="40%" height="12px" style={{ marginTop: 4 }} />
              </div>
            </div>
            <SkeletonText lines={2} />
          </Box>
        ))}
      </div>
    </PageShell>
  )
}

// -- Help page skeleton -------------------------------------------------------

export function HelpPageSkeleton() {
  return (
    <PageShell>
      <div style={{ maxWidth: 800, margin: '0 auto' }}>
        <Skeleton width="100px" height="28px" style={{ marginBottom: tokens.spacing[4] }} />
        <Skeleton width="100%" height="44px" variant="rounded" style={{ marginBottom: tokens.spacing[6] }} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
          {Array.from({ length: 6 }).map((_, i) => (
            <Box key={i} className="glass-card" p={4} radius="lg" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <Skeleton width="70%" height="16px" />
              <Skeleton width="20px" height="20px" variant="circular" />
            </Box>
          ))}
        </div>
      </div>
    </PageShell>
  )
}

// -- Governance page skeleton -------------------------------------------------

export function GovernancePageSkeleton() {
  return (
    <PageShell>
      <Skeleton width="160px" height="28px" style={{ marginBottom: tokens.spacing[5] }} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[4] }}>
        {Array.from({ length: 4 }).map((_, i) => (
          <Box key={i} className="glass-card" p={5} radius="xl" style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <Skeleton width="60%" height="20px" />
              <Skeleton width="80px" height="24px" variant="rounded" />
            </div>
            <SkeletonText lines={2} />
            <div style={{ display: 'flex', gap: tokens.spacing[4] }}>
              <Skeleton width="100px" height="14px" />
              <Skeleton width="80px" height="14px" />
            </div>
          </Box>
        ))}
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

// -- Onboarding page skeleton -------------------------------------------------

export function OnboardingPageSkeleton() {
  return (
    <div style={{ minHeight: '100vh', background: tokens.colors.bg.primary, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ width: '100%', maxWidth: 600, padding: tokens.spacing[6], display: 'flex', flexDirection: 'column', alignItems: 'center', gap: tokens.spacing[5] }}>
        {/* Progress indicator */}
        <div style={{ display: 'flex', gap: tokens.spacing[2] }}>
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} width="40px" height="4px" variant="rounded" />
          ))}
        </div>
        <Skeleton width="240px" height="28px" />
        <Skeleton width="320px" height="16px" />
        {/* Content area */}
        <Box className="glass-card" p={5} radius="xl" style={{ width: '100%' }}>
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2], marginBottom: tokens.spacing[4] }}>
              <Skeleton width="100px" height="14px" />
              <Skeleton width="100%" height="40px" variant="rounded" />
            </div>
          ))}
        </Box>
        <Skeleton width="160px" height="44px" variant="rounded" />
      </div>
    </div>
  )
}

// -- Book detail skeleton -----------------------------------------------------

export function BookDetailPageSkeleton() {
  return (
    <PageShell>
      <div style={{ display: 'flex', gap: tokens.spacing[6] }}>
        {/* Cover */}
        <Skeleton width="200px" height="300px" variant="rounded" style={{ flexShrink: 0 }} />
        {/* Details */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
          <Skeleton width="60%" height="28px" />
          <Skeleton width="40%" height="18px" />
          <div style={{ display: 'flex', gap: tokens.spacing[3], marginTop: tokens.spacing[2] }}>
            <Skeleton width="80px" height="14px" />
            <Skeleton width="80px" height="14px" />
          </div>
          <SkeletonText lines={4} />
          <div style={{ display: 'flex', gap: tokens.spacing[2], marginTop: tokens.spacing[3] }}>
            <Skeleton width="120px" height="40px" variant="rounded" />
            <Skeleton width="120px" height="40px" variant="rounded" />
          </div>
        </div>
      </div>
    </PageShell>
  )
}

// -- Reader skeleton ----------------------------------------------------------

export function ReaderPageSkeleton() {
  return (
    <PageShell>
      <div style={{ maxWidth: 720, margin: '0 auto' }}>
        <Skeleton width="60%" height="32px" style={{ marginBottom: tokens.spacing[6] }} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
          {Array.from({ length: 12 }).map((_, i) => (
            <Skeleton key={i} width={i === 11 ? '45%' : '100%'} height="16px" variant="text" />
          ))}
        </div>
      </div>
    </PageShell>
  )
}

// -- User center / settings-like skeleton -------------------------------------

export function UserCenterPageSkeleton() {
  return (
    <PageShell>
      <div style={{ maxWidth: 800, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[4], marginBottom: tokens.spacing[6] }}>
          <SkeletonAvatar size={64} />
          <div style={{ flex: 1 }}>
            <Skeleton width="150px" height="24px" style={{ marginBottom: 8 }} />
            <Skeleton width="200px" height="14px" />
          </div>
          <Skeleton width="100px" height="36px" variant="rounded" />
        </div>
        {Array.from({ length: 4 }).map((_, i) => (
          <Box key={i} className="glass-card" p={4} radius="lg" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: tokens.spacing[3] }}>
            <div>
              <Skeleton width="120px" height="16px" style={{ marginBottom: 4 }} />
              <Skeleton width="200px" height="12px" />
            </div>
            <Skeleton width="24px" height="24px" variant="rounded" />
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

// -- Post detail page skeleton ------------------------------------------------

export function PostDetailPageSkeleton() {
  return (
    <PageShell>
      <div style={{ maxWidth: 800, margin: '0 auto' }}>
        <Skeleton width="70%" height="28px" style={{ marginBottom: tokens.spacing[4] }} />
        <Skeleton width="40%" height="16px" style={{ marginBottom: tokens.spacing[6] }} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} width={i === 5 ? '45%' : '100%'} height="16px" variant="text" />
          ))}
        </div>
      </div>
    </PageShell>
  )
}

// -- Favorites page skeleton --------------------------------------------------

export function FavoritesPageSkeleton() {
  return (
    <PageShell>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: tokens.spacing[6] }}>
        <Skeleton width="150px" height="32px" />
        <Skeleton width="120px" height="36px" variant="rounded" />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: tokens.spacing[4] }}>
        {Array.from({ length: 6 }).map((_, i) => (
          <Box key={i} className="glass-card" p={4} radius="xl" style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
            <Skeleton width="60%" height="18px" />
            <Skeleton width="40%" height="14px" />
            <Skeleton width="80px" height="12px" />
          </Box>
        ))}
      </div>
    </PageShell>
  )
}

// -- Group detail page skeleton -----------------------------------------------

export function GroupDetailPageSkeleton() {
  return (
    <PageShell>
      <div style={{ maxWidth: 900, margin: '0 auto' }}>
        {/* Header */}
        <Box className="glass-card" p={4} radius="lg" style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[4], marginBottom: tokens.spacing[6] }}>
          <SkeletonAvatar size={64} />
          <div style={{ flex: 1 }}>
            <Skeleton width="180px" height="24px" style={{ marginBottom: 8 }} />
            <Skeleton width="80%" height="16px" />
          </div>
          <Skeleton width="80px" height="36px" variant="rounded" />
        </Box>
        {/* Posts */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[4] }}>
          {Array.from({ length: 3 }).map((_, i) => (
            <Box key={i} className="glass-card" p={4} radius="xl" style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3] }}>
                <SkeletonAvatar size={40} />
                <div style={{ flex: 1 }}>
                  <Skeleton width="100px" height="14px" />
                  <Skeleton width="60px" height="10px" style={{ marginTop: 4 }} />
                </div>
              </div>
              <SkeletonText lines={2} />
            </Box>
          ))}
        </div>
      </div>
    </PageShell>
  )
}

// -- Group manage page skeleton -----------------------------------------------

export function GroupManagePageSkeleton() {
  return (
    <PageShell>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: tokens.spacing[6] }}>
        <Skeleton width="180px" height="32px" />
        <Skeleton width="100px" height="36px" variant="rounded" />
      </div>
      {/* Tabs */}
      <div style={{ display: 'flex', gap: tokens.spacing[4], marginBottom: tokens.spacing[6], borderBottom: `1px solid ${tokens.colors.border.primary}`, paddingBottom: tokens.spacing[3] }}>
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} width="100px" height="20px" />
        ))}
      </div>
      {/* Content */}
      <Box className="glass-card" p={6} radius="xl" style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[4] }}>
        <Skeleton width="150px" height="24px" />
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: tokens.spacing[3] }}>
            <Skeleton width="200px" height="16px" />
            <Skeleton width="80px" height="32px" variant="rounded" />
          </div>
        ))}
      </Box>
    </PageShell>
  )
}

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
      <div className="profile-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: tokens.spacing[6] }}>
        <Skeleton width="100%" height="400px" variant="rounded" />
        <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[6] }}>
          <Skeleton width="100%" height="150px" variant="rounded" />
          <Skeleton width="100%" height="150px" variant="rounded" />
        </div>
      </div>
    </PageShell>
  )
}
