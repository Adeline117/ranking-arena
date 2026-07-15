/**
 * BetaBanner — Server-rendered for LCP optimization.
 *
 * Previously a 'use client' component loaded via dynamic() — this made it
 * invisible until JS hydrated (~3-5s on slow 4G), which could cause it to
 * become the LCP element when it popped in late.
 *
 * Now rendered as a server component with fixed positioning (no layout shift).
 * Dismiss logic is handled via a tiny inline script that reads localStorage
 * before paint and sets an attribute on the hydration-suppressed root element.
 * CSS owns visibility, so the script never mutates React-managed banner markup.
 *
 * i18n: because this is server-rendered in the root layout (which stays static
 * for homepage LCP and does NOT read the language cookie), we render all four
 * localized variants and let CSS select the one matching the root `lang`
 * attribute set by app/layout.tsx before paint. English is the default (shown
 * when JS is disabled or no preference is stored). This keeps the component
 * fully static — no dynamic layout, no LCP/SSG regression — while localizing.
 */

import en from '@/lib/i18n/en'
import ja from '@/lib/i18n/ja'
import ko from '@/lib/i18n/ko'
import zh from '@/lib/i18n/zh'
import { PRO_FREE_PROMO } from '@/lib/types/premium'

const LANGS = [
  { code: 'en', dict: en },
  { code: 'ja', dict: ja },
  { code: 'ko', dict: ko },
  { code: 'zh', dict: zh },
] as const

export default function BetaBanner() {
  // Shown by default on all pages (rendered in root layout); set
  // NEXT_PUBLIC_HIDE_BETA_BANNER=true to turn it off without a code change
  if (process.env.NEXT_PUBLIC_HIDE_BETA_BANNER === 'true') return null

  // The time-bound Pro promotion owns the single announcement slot. Do not
  // render a second banner and mutate it to display:none before hydration —
  // that produced a root-layout hydration mismatch on every app route.
  if (PRO_FREE_PROMO) return null

  return (
    <>
      <div
        id="beta-banner"
        className="beta-banner"
        style={{
          background: 'linear-gradient(90deg, #f59e0b, #ef4444)',
          color: 'white',
          textAlign: 'center',
          padding: '10px 48px 10px 16px',
          fontSize: '14px',
          fontWeight: 600,
          position: 'relative',
          zIndex: 1 /* flows in document — no longer overlaps sticky header */,
        }}
      >
        {/* One wrapper per language. English shows by default; the inline script
            reveals the wrapper matching localStorage.language and hides the rest.
            Within the shown wrapper, .beta-full/.beta-short toggle via CSS on
            small screens (terser copy on mobile). */}
        {LANGS.map(({ code, dict }) => (
          <span key={code} className="beta-lang" data-beta-lang={code}>
            <span className="beta-full">{dict.betaBannerFull}</span>
            <span className="beta-short">{dict.betaBannerShort}</span>
          </span>
        ))}
        <button
          id="beta-banner-dismiss"
          aria-label="Dismiss"
          style={{
            position: 'absolute',
            right: 4,
            top: '50%',
            transform: 'translateY(-50%)',
            background: 'transparent',
            border: 'none',
            color: 'white',
            fontSize: '18px',
            cursor: 'pointer',
            padding: '8px 12px',
            lineHeight: 1,
            opacity: 0.8,
            minWidth: 44,
            minHeight: 44,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          ✕
        </button>
      </div>
      {/* Inline script only writes state onto the root element, whose hydration
          warning is suppressed in app/layout.tsx. It deliberately does not
          mutate React-owned banner styles/text before hydration. */}
      <script
        dangerouslySetInnerHTML={{
          __html: `(function(){var k='beta-banner-dismissed-at',root=document.documentElement,b=document.getElementById('beta-banner');if(!b)return;try{var d=localStorage.getItem(k);if(d&&Date.now()-Number(d)<2592e6)root.setAttribute('data-beta-banner-hidden','true')}catch(e){}var btn=document.getElementById('beta-banner-dismiss');if(btn)btn.onclick=function(){try{localStorage.setItem(k,String(Date.now()))}catch(e){}root.setAttribute('data-beta-banner-hidden','true')}})()`,
        }}
      />
    </>
  )
}
