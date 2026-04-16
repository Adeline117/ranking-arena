import React from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box } from '../../base'
import { Skeleton, SkeletonAvatar, SkeletonText } from '../Skeleton'
import { PageShell } from './PageShell'

// -- Settings page skeleton ---------------------------------------------------

export function SettingsPageSkeleton() {
  return (
    <PageShell>
      <div style={{ display: 'flex', gap: tokens.spacing[6] }}>
        <div style={{ width: 200, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} width="100%" height="36px" variant="rounded" />
          ))}
        </div>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: tokens.spacing[6] }}>
          <Box className="glass-card" p={6} radius="xl" style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[5] }}>
            <Skeleton width="140px" height="24px" />
            <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[4] }}>
              <SkeletonAvatar size={72} />
              <Skeleton width="120px" height="36px" variant="rounded" />
            </div>
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
                <Skeleton width="80px" height="14px" />
                <Skeleton width="100%" height="40px" variant="rounded" />
              </div>
            ))}
            <Skeleton width="100px" height="40px" variant="rounded" />
          </Box>
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

// -- Search page skeleton -----------------------------------------------------

export function SearchPageSkeleton() {
  return (
    <PageShell>
      <div style={{ maxWidth: 680, margin: '0 auto' }}>
        <div style={{ display: 'flex', gap: tokens.spacing[2], marginBottom: tokens.spacing[4] }}>
          {/* Deterministic widths to avoid hydration mismatch (previously used Math.random) */}
          {[56, 64, 52, 68, 60].map((w, i) => (
            <Skeleton key={i} width={`${w}px`} height="36px" variant="rounded" />
          ))}
        </div>
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

// -- Admin page skeleton (table-based) ----------------------------------------

export function AdminPageSkeleton() {
  return (
    <PageShell>
      <Skeleton width="180px" height="28px" style={{ marginBottom: tokens.spacing[5] }} />
      <div style={{ display: 'flex', gap: tokens.spacing[3], marginBottom: tokens.spacing[4] }}>
        <Skeleton width="200px" height="36px" variant="rounded" />
        <Skeleton width="120px" height="36px" variant="rounded" />
      </div>
      <Box className="glass-card" p={4} radius="xl">
        <div style={{ display: 'grid', gridTemplateColumns: '60px 1fr 120px 120px 100px', gap: tokens.spacing[3], padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`, marginBottom: tokens.spacing[2] }}>
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} width="70%" height="12px" />
          ))}
        </div>
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

// -- Onboarding page skeleton -------------------------------------------------

export function OnboardingPageSkeleton() {
  return (
    <div style={{ minHeight: '100vh', background: tokens.colors.bg.primary, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ width: '100%', maxWidth: 600, padding: tokens.spacing[6], display: 'flex', flexDirection: 'column', alignItems: 'center', gap: tokens.spacing[5] }}>
        <div style={{ display: 'flex', gap: tokens.spacing[2] }}>
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} width="40px" height="4px" variant="rounded" />
          ))}
        </div>
        <Skeleton width="240px" height="28px" />
        <Skeleton width="320px" height="16px" />
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

// -- User profile page skeleton -----------------------------------------------

export function UserProfilePageSkeleton() {
  return (
    <PageShell>
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
