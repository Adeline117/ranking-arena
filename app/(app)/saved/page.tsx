import { Metadata } from 'next'
import { Suspense } from 'react'
import { BASE_URL } from '@/lib/constants/urls'
import SavedHub from './SavedHub'

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

// SavedHub 用 useSearchParams(需 Suspense 边界)
export default function SavedPage() {
  return (
    <Suspense fallback={null}>
      <SavedHub />
    </Suspense>
  )
}
