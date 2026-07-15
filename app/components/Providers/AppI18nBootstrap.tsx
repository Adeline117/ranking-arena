'use client'

import type { ReactNode } from 'react'
import enFull from '@/lib/i18n/en'
import { registerFullDict } from '@/lib/i18n'

// Every route under (app) renders through LanguageProvider. Register the same
// complete English dictionary at module evaluation on both the server and the
// browser, before either side performs its first render. This prevents build
// workers that previously visited pricing/help from leaving the server cache in
// a fuller state than a fresh browser cache (React text hydration error #418).
//
// The provider-light homepage does not use this layout, so its LCP bundle keeps
// the small en-core dictionary instead of paying for the full feature catalog.
registerFullDict('en', enFull)

export default function AppI18nBootstrap({ children }: { children: ReactNode }) {
  return children
}
