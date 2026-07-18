/**
 * ProPromoBanner — server-rendered so it occupies its final document-flow
 * height on the first paint.
 *
 * Dismissal and language selection are both resolved before paint:
 * - app/layout.tsx sets the root `lang` attribute from localStorage.
 * - the inline script below records dismissal on the hydration-suppressed
 *   root element.
 * - critical CSS selects one localized string and hides dismissed banners.
 *
 * Keeping those decisions outside React state avoids inserting a full-width
 * banner after hydration, which used to push the entire homepage down.
 */

import en from '@/lib/i18n/en'
import ja from '@/lib/i18n/ja'
import ko from '@/lib/i18n/ko'
import zh from '@/lib/i18n/zh'
import { PRO_FREE_PROMO } from '@/lib/types/premium'
import { tokens } from '@/lib/design-tokens'

const LANGS = [
  {
    code: 'en',
    text: en.proPromoBanner,
    shortText: en.proPromoBannerShort,
    dismiss: en.proPromoBannerDismiss,
  },
  {
    code: 'ja',
    text: ja.proPromoBanner,
    shortText: ja.proPromoBannerShort,
    dismiss: ja.proPromoBannerDismiss,
  },
  {
    code: 'ko',
    text: ko.proPromoBanner,
    shortText: ko.proPromoBannerShort,
    dismiss: ko.proPromoBannerDismiss,
  },
  {
    code: 'zh',
    text: zh.proPromoBanner,
    shortText: zh.proPromoBannerShort,
    dismiss: zh.proPromoBannerDismiss,
  },
] as const

export default function ProPromoBanner() {
  if (!PRO_FREE_PROMO) return null

  return (
    <>
      <div
        id="pro-promo-banner"
        role="status"
        className="pro-promo-banner"
        style={{
          background: tokens.gradient.success,
          color: 'white',
          textAlign: 'center',
          padding: `${tokens.spacing[2.5]} ${tokens.spacing[12]} ${tokens.spacing[2.5]} ${tokens.spacing[4]}`,
          fontSize: tokens.typography.fontSize.base,
          fontWeight: tokens.typography.fontWeight.semibold,
          position: 'relative',
          zIndex: 1,
        }}
      >
        <span className="pro-promo-text">
          {LANGS.map(({ code, text, shortText }) => (
            <span key={code} className="pro-promo-lang" data-pro-promo-lang={code}>
              <span className="pro-promo-full">{text}</span>
              <span className="pro-promo-short">{shortText}</span>
            </span>
          ))}
        </span>
        <button
          id="pro-promo-banner-dismiss"
          type="button"
          style={{
            position: 'absolute',
            right: tokens.spacing[1],
            top: '50%',
            transform: 'translateY(-50%)',
            background: 'transparent',
            border: 'none',
            color: 'white',
            fontSize: tokens.typography.fontSize.lg,
            cursor: 'pointer',
            padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
            lineHeight: 1,
            opacity: 0.85,
            minWidth: 44,
            minHeight: 44,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <span aria-hidden="true">✕</span>
          <span className="sr-only">
            {LANGS.map(({ code, dismiss }) => (
              <span key={code} className="pro-promo-lang" data-pro-promo-lang={code}>
                {dismiss}
              </span>
            ))}
          </span>
        </button>
      </div>
      <script
        dangerouslySetInnerHTML={{
          __html: `(function(){var k='pro-free-promo-dismissed',root=document.documentElement,b=document.getElementById('pro-promo-banner');if(!b)return;try{if(localStorage.getItem(k)==='1')root.setAttribute('data-pro-promo-hidden','true')}catch(e){}var btn=document.getElementById('pro-promo-banner-dismiss');if(btn)btn.onclick=function(){try{localStorage.setItem(k,'1')}catch(e){}root.setAttribute('data-pro-promo-hidden','true')}})()`,
        }}
      />
    </>
  )
}
