'use client'

import { useLanguage } from '@/lib/i18n/client'

/**
 * Translated text slot for the server-rendered homepage hero.
 *
 * HomeHeroSSR must stay free of cookies() so `/` keeps its ISR cache, which
 * means the server can only render the default (English) copy. This slot
 * renders that same English on the server and on the first client render
 * (useLanguage starts at 'en' to stay hydration-safe), then switches to the
 * visitor's saved language right after mount — the same strategy as the
 * ranking controls below it.
 */
export default function HomeHeroText({
  k,
  vars,
}: {
  k: string
  vars?: Readonly<Record<string, string | number>>
}) {
  const { t } = useLanguage()
  let text = t(k)
  if (vars) {
    for (const [name, value] of Object.entries(vars)) {
      text = text.replaceAll(`{${name}}`, String(value))
    }
  }
  return <>{text}</>
}
