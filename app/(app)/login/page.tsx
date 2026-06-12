/**
 * Server shell for /login (Wave-3 SSR conversion).
 * Metadata lives in layout.tsx; the form (supabase-js, localStorage,
 * useSearchParams) stays in the client leaf behind Suspense.
 */

import { Suspense } from 'react'
import { CenteredFormSkeleton } from '@/app/components/ui/PageSkeleton'
import LoginPageClient from './LoginPageClient'

export default function LoginPage() {
  return (
    <Suspense fallback={<CenteredFormSkeleton fields={2} />}>
      <LoginPageClient />
    </Suspense>
  )
}
