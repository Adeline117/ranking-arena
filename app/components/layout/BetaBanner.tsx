/**
 * BetaBanner — Server-rendered for LCP optimization.
 *
 * Previously a 'use client' component loaded via dynamic() — this made it
 * invisible until JS hydrated (~3-5s on slow 4G), which could cause it to
 * become the LCP element when it popped in late.
 *
 * Now rendered as a server component with fixed positioning (no layout shift).
 * Dismiss logic is handled via a tiny inline script that reads localStorage
 * before paint, avoiding a flash of the banner for dismissed users.
 *
 * i18n: because this is server-rendered in the root layout (which stays static
 * for homepage LCP and does NOT read the language cookie), we render all four
 * localized variants and let the same pre-paint inline script pick the one that
 * matches localStorage.getItem('language'). English is the default (shown when
 * JS is disabled or no preference is stored). This keeps the component fully
 * static — no dynamic layout, no LCP/SSG regression — while still localizing.
 */

import en from '@/lib/i18n/en'
import ja from '@/lib/i18n/ja'
import ko from '@/lib/i18n/ko'
import zh from '@/lib/i18n/zh'

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
          <span
            key={code}
            className="beta-lang"
            data-beta-lang={code}
            style={code === 'en' ? undefined : { display: 'none' }}
          >
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
      {/* Inline script: pick the localized variant, hide if dismissed <30d ago,
          attach click handler. Runs synchronously before paint to avoid flash. */}
      <script
        dangerouslySetInnerHTML={{
          __html: `(function(){var k='beta-banner-dismissed-at',b=document.getElementById('beta-banner');if(!b)return;try{var lang=localStorage.getItem('language');if(lang!=='ja'&&lang!=='ko'&&lang!=='zh')lang='en';var ws=b.querySelectorAll('.beta-lang');for(var i=0;i<ws.length;i++){ws[i].style.display=ws[i].getAttribute('data-beta-lang')===lang?'':'none'}}catch(e){}try{var d=localStorage.getItem(k);if(d&&Date.now()-Number(d)<2592e6){b.style.display='none';return}}catch(e){}var btn=document.getElementById('beta-banner-dismiss');if(btn)btn.onclick=function(){try{localStorage.setItem(k,String(Date.now()))}catch(e){}b.style.display='none'}})()`,
        }}
      />
    </>
  )
}
