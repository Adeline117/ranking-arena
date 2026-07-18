import { Metadata } from 'next'
import { Suspense } from 'react'
import { BASE_URL } from '@/lib/constants/urls'
import SavedHub from './SavedHub'
import { Skeleton } from '@/app/components/ui/Skeleton'
import LoadingSkeleton from '@/app/components/ui/LoadingSkeleton'
import { tokens } from '@/lib/design-tokens'

export const metadata: Metadata = {
  title: 'Saved',
  description: 'Your saved traders and post collections in one place.',
  alternates: { canonical: `${BASE_URL}/saved` },
  openGraph: {
    title: 'Saved · Arena',
    description: 'Your saved traders and post collections in one place.',
    url: `${BASE_URL}/saved`,
    siteName: 'Arena',
    type: 'website',
  },
}

function SavedHubFallback() {
  return (
    <div
      aria-busy="true"
      style={{ maxWidth: 1120, margin: '0 auto', padding: `0 ${tokens.spacing[4]}` }}
    >
      <Skeleton
        width={120}
        height={28}
        style={{ margin: `${tokens.spacing[5]} 0 ${tokens.spacing[2]}` }}
      />
      <Skeleton width={280} height={14} style={{ marginBottom: tokens.spacing[4] }} />
      <div
        style={{
          display: 'flex',
          gap: tokens.spacing[2],
          paddingBottom: tokens.spacing[2],
          borderBottom: `1px solid ${tokens.colors.border.primary}`,
          marginBottom: tokens.spacing[4],
        }}
      >
        {[72, 64, 58].map((width) => (
          <Skeleton key={width} width={width} height={32} />
        ))}
      </div>
      <LoadingSkeleton variant="list" count={5} />
    </div>
  )
}

// SavedHub 用 useSearchParams(需 Suspense 边界)
export default function SavedPage() {
  return (
    <Suspense fallback={<SavedHubFallback />}>
      <SavedHub />
    </Suspense>
  )
}
