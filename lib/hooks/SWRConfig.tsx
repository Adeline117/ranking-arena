'use client'

import { ReactNode } from 'react'

/**
 * SWRConfigProvider — now a no-op pass-through.
 *
 * All data-fetching hooks have been migrated to React Query.
 * This component is kept as a pass-through to avoid breaking the
 * Providers tree in app/components/Providers/index.tsx.
 *
 * TODO: Remove this file and its usage in Providers/index.tsx once
 * the SWR package is fully uninstalled.
 */
export function SWRConfigProvider({ children }: { children: ReactNode }) {
  return <>{children}</>
}
