'use client'

// The language context lives in lib/i18n/client so lib/ hooks never import app/.
// Re-exported here for the existing app-side import path (one context instance).
// Named re-exports: Next.js rejects `export *` in a client boundary.
export { LanguageProvider, useLanguage } from '@/lib/i18n/client'
export type { TranslationFunction } from '@/lib/i18n/client'
