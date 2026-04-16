import React from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box } from '../../base'
import { Skeleton, SkeletonAvatar, SkeletonText } from '../Skeleton'
import { PageShell } from './PageShell'

// -- Groups page skeleton -----------------------------------------

export function GroupsPageSkeleton() {
  return (
    <PageShell>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: tokens.spacing[6] }}>
        <Skeleton width="120px" height="32px" />
        <Skeleton width="120px" height="36px" variant="rounded" />
      </div>
      <div style={{ display: 'flex', gap: tokens.spacing[4], marginBottom: tokens.spacing[6], borderBottom: `1px solid ${tokens.colors.border.primary}`, paddingBottom: tokens.spacing[3] }}>
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} width="80px" height="20px" />
        ))}
      </div>
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

// -- Group detail page skeleton -----------------------------------------------

export function GroupDetailPageSkeleton() {
  return (
    <PageShell>
      <div style={{ maxWidth: 900, margin: '0 auto' }}>
        <Box className="glass-card" p={4} radius="lg" style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[4], marginBottom: tokens.spacing[6] }}>
          <SkeletonAvatar size={64} />
          <div style={{ flex: 1 }}>
            <Skeleton width="180px" height="24px" style={{ marginBottom: 8 }} />
            <Skeleton width="80%" height="16px" />
          </div>
          <Skeleton width="80px" height="36px" variant="rounded" />
        </Box>
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
      <div style={{ display: 'flex', gap: tokens.spacing[4], marginBottom: tokens.spacing[6], borderBottom: `1px solid ${tokens.colors.border.primary}`, paddingBottom: tokens.spacing[3] }}>
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} width="100px" height="20px" />
        ))}
      </div>
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

// -- Post feed page skeleton -----------------------

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
      <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3], marginBottom: tokens.spacing[5], paddingBottom: tokens.spacing[4], borderBottom: `1px solid ${tokens.colors.border.primary}` }}>
        <SkeletonAvatar size={48} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[1] }}>
          <Skeleton width="120px" height="18px" />
          <Skeleton width="80px" height="12px" />
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[4] }}>
        {/* Deterministic widths to avoid hydration mismatch (previously used Math.random) */}
        {[180, 240, 140, 280, 200].map((w, i) => (
          <div key={i} style={{ display: 'flex', gap: tokens.spacing[3], justifyContent: i % 2 === 0 ? 'flex-start' : 'flex-end' }}>
            {i % 2 === 0 && <SkeletonAvatar size={32} />}
            <Skeleton width={`${w}px`} height="40px" variant="rounded" />
          </div>
        ))}
      </div>
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
