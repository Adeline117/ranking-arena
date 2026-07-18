import type { Metadata, Viewport } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'
import { JsonLd } from './components/Providers/JsonLd'
import { BASE_URL } from '@/lib/constants/urls'
import { getCriticalCss, getResourceHints } from '@/lib/performance/critical-css'
import BetaBanner from './components/layout/BetaBanner'
import ProPromoBanner from './components/layout/ProPromoBanner'
import { Analytics } from '@vercel/analytics/next'
// Mounted in the ROOT layout (not just (app)/) so the homepage — the #1 airdrop
// landing page — is no longer a client-error monitoring blind spot. Safe for LCP:
// lib/sentry-init defers the Sentry chunk to requestIdleCallback (after `load`),
// and its module-level `initialized` guard makes the (app)/ double-mount a no-op.
import SentryInit from './components/Providers/SentryInit'
import { PRODUCT_FACTS } from '@/lib/config/product-facts'

const exchangeCoverage = `${PRODUCT_FACTS.fallbackExchangeCount}+ active exchange sources`

// Optimized font loading — 3 weights for better typographic hierarchy, 'optional' avoids font-swap LCP delay
const inter = Inter({
  subsets: ['latin'],
  weight: ['400', '500', '700'],
  display: 'optional',
  variable: '--font-inter',
  preload: true,
  adjustFontFallback: true,
})

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 2,
  userScalable: true,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: dark)', color: '#0B0A10' },
    { media: '(prefers-color-scheme: light)', color: '#FFFFFF' },
  ],
}

export const metadata: Metadata = {
  title: {
    default: 'Arena | All Rankings in Crypto',
    template: '%s | Arena',
  },
  description: `All rankings in crypto. Arena tracks top traders across ${exchangeCoverage} — ranked by ROI, Arena Score, and PnL.`,
  metadataBase: new URL(BASE_URL),
  verification: {
    google: 'nnTiBxpNMeCgo9rCLyUbZV9Z-OE8Nr-BLh7E-o2T1R8',
  },
  applicationName: 'Arena',
  keywords: [
    'crypto trader ranking',
    'crypto leaderboard',
    'copy trading',
    'best crypto traders',
    'binance trader ranking',
    'hyperliquid leaderboard',
    'crypto ROI ranking',
    'top crypto traders',
    '跟单交易',
    '交易员排行榜',
    '加密货币交易员',
    'ROI排行',
    '交易社区',
    'Copy Trading',
    'Trader Ranking',
    'Crypto Leaderboard',
  ],
  manifest: '/manifest.json',
  icons: {
    icon: [
      { url: '/favicon.ico?v=3', sizes: 'any' },
      { url: '/icons/icon.svg?v=3', type: 'image/svg+xml' },
      { url: '/icons/icon-192x192.png?v=3', sizes: '192x192', type: 'image/png' },
    ],
    apple: [{ url: '/icons/apple-touch-icon.png?v=3', sizes: '180x180', type: 'image/png' }],
  },
  appleWebApp: { capable: true, statusBarStyle: 'black-translucent', title: 'Arena' },
  formatDetection: { telephone: false },
  alternates: {
    canonical: BASE_URL,
    // Language preference is client-side (localStorage), so URLs are the same
    // across languages. Declare each locale variant so Google can discover them
    // and x-default so the English version is the fallback for unlisted locales.
    // See: https://developers.google.com/search/docs/specialty/international/localized-versions
    languages: {
      en: BASE_URL,
      'zh-CN': BASE_URL,
      ja: BASE_URL,
      ko: BASE_URL,
      'x-default': BASE_URL,
    },
  },
  openGraph: {
    type: 'website',
    title: 'Arena ranks everything in crypto',
    description: `All rankings in crypto. Arena tracks top traders across ${exchangeCoverage} — ranked by ROI, Arena Score, and PnL.`,
    url: BASE_URL,
    siteName: 'Arena',
    locale: 'en_US',
    images: [
      {
        url: `${BASE_URL}/api/og?title=Arena&subtitle=All+rankings+in+crypto`,
        width: 1200,
        height: 630,
        alt: 'Arena — All Rankings in Crypto',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Arena ranks everything in crypto',
    description: `All rankings in crypto. Arena tracks top traders across ${exchangeCoverage} — ranked by ROI, Arena Score, and PnL.`,
    images: [`${BASE_URL}/api/og?title=Arena&subtitle=All+rankings+in+crypto`],
    creator: '@arenafi',
    site: '@arenafi',
  },
  robots: { index: true, follow: true },
}

/**
 * Root layout — MINIMAL.
 * Only HTML structure, fonts, critical CSS, theme detection.
 * NO Providers — those are in (app)/layout.tsx for non-homepage pages.
 * Homepage loads zero Provider JS → LCP = FCP ≈ 1.5s.
 */
export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html
      lang="en"
      dir="ltr"
      data-theme="dark"
      translate="no"
      className={inter.variable}
      suppressHydrationWarning
    >
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var l=localStorage.getItem('language');if(!l){var n=(navigator.language||'').toLowerCase();l=n.indexOf('zh')===0?'zh':n.indexOf('ja')===0?'ja':n.indexOf('ko')===0?'ko':'en';localStorage.setItem('language',l)}document.documentElement.lang=l==='en'?'en':l==='ja'?'ja':l==='ko'?'ko':'zh-CN';document.cookie='language='+l+';path=/;max-age=31536000;SameSite=Lax'}catch(e){}`,
          }}
        />
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var t=localStorage.getItem('theme');var e=t==='light'?'light':t==='dark'?'dark':window.matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light';document.documentElement.setAttribute('data-theme',e)}catch(x){}`,
          }}
        />
        {/* Referral capture — runs pre-hydration so it works on the homepage,
            which omits Providers (no React runs there). Stores a `?ref` code in
            localStorage for the unified applier to consume after signup.
            MUST stay in sync with lib/referral/pending.ts: same key
            ('arena_pending_ref'), same charset ([A-Za-z0-9_-]{2,64}), same
            { code, ts } shape, 30-day TTL. Fail-open, self-contained. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var r=new URLSearchParams(location.search).get('ref');if(r&&/^[A-Za-z0-9_-]{2,64}$/.test(r)){var K='arena_pending_ref',T=2592000000,ok=true,x=localStorage.getItem(K);if(x){try{var p=JSON.parse(x);if(p&&typeof p.ts==='number'&&Date.now()-p.ts<=T)ok=false}catch(e){}}if(ok)localStorage.setItem(K,JSON.stringify({code:r,ts:Date.now()}))}}catch(e){}`,
          }}
        />
        <script
          dangerouslySetInnerHTML={{
            __html: `if(!AbortSignal.timeout){AbortSignal.timeout=function(ms){var c=new AbortController();setTimeout(function(){c.abort(new DOMException('TimeoutError','TimeoutError'))},ms);return c.signal}}`,
          }}
        />
        {/* SW recovery: register/update SW inline so it runs even if React fails to mount.
            This breaks the deadlock where a broken old SW prevents JS chunks from loading,
            which prevents React from mounting, which prevents the SW update component from running. */}
        <script
          dangerouslySetInnerHTML={{
            __html: [
              // Register SW with updateViaCache:'none' to always check server for updates
              `if('serviceWorker' in navigator){navigator.serviceWorker.register('/sw.js',{updateViaCache:'none'}).catch(function(){})}`,
            ].join(''),
          }}
        />
        <style dangerouslySetInnerHTML={{ __html: getCriticalCss() }} />
        {getResourceHints().map((hint, index) => (
          <link
            key={`resource-hint-${index}`}
            rel={hint.rel}
            href={hint.href}
            {...(hint.crossOrigin && { crossOrigin: hint.crossOrigin })}
          />
        ))}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){var a=document.createElement('link');a.rel='stylesheet';a.href='/styles/responsive.css';a.media='print';a.onload=function(){a.media='all'};document.head.appendChild(a)})()`,
          }}
        />
        <noscript>
          {/* eslint-disable-next-line @next/next/no-css-tags */}
          <link rel="stylesheet" href="/styles/responsive.css" />
          {/* eslint-disable-next-line @next/next/no-css-tags */}
          <link rel="stylesheet" href="/styles/animations.css" />
          <div
            style={{
              position: 'fixed',
              top: 0,
              left: 0,
              right: 0,
              padding: '12px 16px',
              background: '#1a1a2e',
              color: '#e5e5e5',
              textAlign: 'center',
              fontFamily: 'system-ui, sans-serif',
              zIndex: 9999,
              borderBottom: '1px solid #333',
            }}
          >
            JavaScript is required for full functionality. / 需要启用 JavaScript 才能使用完整功能。{' '}
            <a href="/" style={{ color: '#8b5cf6', textDecoration: 'underline' }}>
              View rankings / 查看排名
            </a>
          </div>
        </noscript>
        <JsonLd
          data={{
            '@context': 'https://schema.org',
            '@type': 'WebSite',
            name: 'Arena',
            url: BASE_URL,
            description: `Crypto trader rankings across ${exchangeCoverage}.`,
            potentialAction: {
              '@type': 'SearchAction',
              target: {
                '@type': 'EntryPoint',
                urlTemplate: `${BASE_URL}/search?q={search_term_string}`,
              },
              'query-input': 'required name=search_term_string',
            },
          }}
        />
        {/* Speculation Rules — pre-render/prefetch likely navigation targets for near-zero LCP.
            Chrome 121+ only; other browsers safely ignore the script type.
            SCOPED: prerender only top-level nav (not /trader/* — homepage has ~50 trader links
            that would steal main-thread CPU/network during LCP window). Trader profiles are
            prefetched on conservative hover, not prerendered. */}
        <script
          type="speculationrules"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              prerender: [
                {
                  where: {
                    and: [
                      { href_matches: '/rankings' },
                      { not: { selector_matches: '[rel~=nofollow]' } },
                    ],
                  },
                  eagerness: 'conservative',
                },
                {
                  where: {
                    and: [
                      { href_matches: '/market' },
                      { not: { selector_matches: '[rel~=nofollow]' } },
                    ],
                  },
                  eagerness: 'conservative',
                },
              ],
              prefetch: [
                {
                  where: {
                    and: [
                      { href_matches: '/*' },
                      { not: { href_matches: '/api/*' } },
                      { not: { href_matches: '/auth/*' } },
                    ],
                  },
                  eagerness: 'conservative',
                },
              ],
            }),
          }}
        />
      </head>
      <body
        className="font-sans antialiased"
        style={{
          fontFamily:
            'var(--font-inter), "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", system-ui, sans-serif',
        }}
        suppressHydrationWarning
      >
        <SentryInit />
        <BetaBanner />
        <ProPromoBanner />
        {children}
        {/* Root-level so the provider-light homepage records landing and
            ranking funnel events too. The nested app layout must not mount a
            second instance. */}
        <Analytics />
      </body>
    </html>
  )
}
