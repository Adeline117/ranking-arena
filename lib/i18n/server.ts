/**
 * Server-side i18n helper for Server Components.
 *
 * Reads the user's language preference from the `language` cookie
 * (synced from localStorage by the client-side setLanguage() and
 * the inline script in app/layout.tsx).
 *
 * Falls back to Accept-Language header, then to English.
 *
 * Usage in a Server Component:
 *   import { getServerTranslation } from '@/lib/i18n/server'
 *   const { t, lang } = await getServerTranslation()
 */

import { cookies, headers } from 'next/headers'
import type { Language } from '../i18n'

// Synchronous require — safe on server, not shipped to client bundle.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const en: Record<string, string> = require('./en').default
// eslint-disable-next-line @typescript-eslint/no-require-imports
const zh: Record<string, string> = require('./zh').default
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ja: Record<string, string> = require('./ja').default
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ko: Record<string, string> = require('./ko').default

const dictionaries: Record<Language, Record<string, string>> = { en, zh, ja, ko }
const validLangs = new Set<string>(['en', 'zh', 'ja', 'ko'])

function isValidLang(v: string | undefined | null): v is Language {
  return typeof v === 'string' && validLangs.has(v)
}

/**
 * Detect language from Accept-Language header.
 * Returns the first matching supported language, or null.
 */
function detectFromAcceptLanguage(header: string | null): Language | null {
  if (!header) return null
  // Accept-Language values look like "zh-CN,zh;q=0.9,en;q=0.8,ja;q=0.7"
  const parts = header.split(',')
  for (const part of parts) {
    const lang = part.trim().split(';')[0].toLowerCase()
    if (lang.startsWith('zh')) return 'zh'
    if (lang.startsWith('ja')) return 'ja'
    if (lang.startsWith('ko')) return 'ko'
    if (lang.startsWith('en')) return 'en'
  }
  return null
}

/**
 * Static-safe 翻译(2026-07-12,首页 ISR 根因修复):不碰 cookies()/headers(),
 * 纯查表 —— 可用于 ISR/静态预渲染路由的服务端组件。
 *
 * 背景:getServerTranslation() 的 cookies() 调用把整个 `/` 路由判为动态
 * (build 实测 `Route / couldn't be rendered statically because it used cookies()`),
 * revalidate=300 被整体忽略 → 宣传第一落点零边缘缓存。首页 SSR 壳
 * (HomeHeroSSR/SSRRankingTable)改用本函数固定英文 —— 与 page.tsx 既有决策
 * 一致("SSR 恒渲染默认视图保 edge 缓存,客户端水合后切换"):静态壳出英文,
 * 客户端 Phase 2(useLanguage)水合后换语言。
 */
export function getStaticTranslation(lang: Language = 'en'): {
  t: (key: string) => string
  lang: Language
} {
  const dict = dictionaries[lang]
  const fallback = dictionaries.en
  return {
    t: (key: string) => dict[key] || fallback[key] || key,
    lang,
  }
}

export async function getServerTranslation(): Promise<{
  t: (key: string) => string
  lang: Language
}> {
  const cookieStore = await cookies()
  const headerStore = await headers()

  // 1. Check cookie (set by client-side language switcher + inline script)
  const cookieLang = cookieStore.get('language')?.value
  let lang: Language = 'en'

  if (isValidLang(cookieLang)) {
    lang = cookieLang
  } else {
    // 2. Fall back to Accept-Language header
    const detected = detectFromAcceptLanguage(headerStore.get('accept-language'))
    if (detected) lang = detected
  }

  const dict = dictionaries[lang]
  const fallback = dictionaries.en

  return {
    t: (key: string) => dict[key] || fallback[key] || key,
    lang,
  }
}
