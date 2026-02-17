import { Suspense } from 'react'
import { HomePage } from './components/home'
import { getInitialTraders } from '@/lib/getInitialTraders'

// ISR: Revalidate every 60 seconds
export const revalidate = 60

/**
 * 首页 - SSR data passed to client component for instant render.
 * No separate SSR table (was causing CLS 1.0+ from show/hide transition).
 * initialTraders provides data for immediate rendering without client fetch.
 */
export default async function Page() {
  const { traders: initialTraders, lastUpdated } = await getInitialTraders('90D', 25)

  return (
    <Suspense fallback={null}>
      <HomePage
        initialTraders={initialTraders}
        initialLastUpdated={lastUpdated}
      />
    </Suspense>
  )
}
