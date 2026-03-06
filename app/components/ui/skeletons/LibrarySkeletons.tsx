import React from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box } from '../../base'
import { Skeleton, SkeletonText } from '../Skeleton'
import { PageShell } from './PageShell'

// -- Library page skeleton (book card grid) -----------------------------------

export function LibraryPageSkeleton() {
  return (
    <PageShell>
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

// -- Book detail skeleton -----------------------------------------------------

export function BookDetailPageSkeleton() {
  return (
    <PageShell>
      <div style={{ display: 'flex', gap: tokens.spacing[6] }}>
        <Skeleton width="200px" height="300px" variant="rounded" style={{ flexShrink: 0 }} />
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
