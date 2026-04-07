import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { JsonLd } from "./components/Providers/JsonLd";
import { BASE_URL } from "@/lib/constants/urls";
import { getCriticalCss, getResourceHints } from "@/lib/performance/critical-css";

// Optimized font loading — 2 weights instead of 4 saves ~90KB, 'optional' avoids font-swap LCP delay
const inter = Inter({
  subsets: ["latin"],
  weight: ["400", "600"],
  display: "optional",
  variable: "--font-inter",
  preload: true,
  adjustFontFallback: true,
});

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
};

export const metadata: Metadata = {
  title: {
    default: "Arena — All Rankings in Crypto",
    template: "%s | Arena",
  },
  description:
    "All rankings in crypto. Arena tracks top traders from Binance, Bybit, OKX, Hyperliquid, and 30+ exchanges — ranked by ROI, Arena Score, and PnL.",
  metadataBase: new URL(BASE_URL),
  verification: {
    google: 'nnTiBxpNMeCgo9rCLyUbZV9Z-OE8Nr-BLh7E-o2T1R8',
  },
  applicationName: "Arena",
  keywords: [
    "crypto trader ranking", "crypto leaderboard", "copy trading",
    "best crypto traders", "binance trader ranking", "hyperliquid leaderboard",
    "crypto ROI ranking", "top crypto traders 2024",
    "跟单交易", "交易员排行榜", "加密货币交易员", "ROI排行", "交易社区",
    "Copy Trading", "Trader Ranking", "Crypto Leaderboard",
  ],
  manifest: "/manifest.json",
  icons: {
    icon: [
      { url: '/favicon.ico?v=2', sizes: 'any' },
      { url: '/icons/icon.svg?v=2', type: 'image/svg+xml' },
      { url: '/icons/icon-192x192.png?v=2', sizes: '192x192', type: 'image/png' },
    ],
    apple: [
      { url: '/icons/apple-touch-icon.png?v=2', sizes: '180x180', type: 'image/png' },
    ],
  },
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "Arena" },
  formatDetection: { telephone: false },
  alternates: { canonical: BASE_URL },
  openGraph: {
    type: "website",
    title: "Arena ranks everything in crypto",
    description: "All rankings in crypto. Arena tracks top traders from Binance, Bybit, OKX, Hyperliquid, and 30+ exchanges — ranked by ROI, Arena Score, and PnL.",
    url: BASE_URL,
    siteName: "Arena",
    locale: "en_US",
    images: [{ url: `${BASE_URL}/api/og?title=Arena&subtitle=All+rankings+in+crypto`, width: 1200, height: 630, alt: "Arena — All Rankings in Crypto" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Arena ranks everything in crypto",
    description: "All rankings in crypto. Arena tracks top traders from Binance, Bybit, OKX, Hyperliquid, and 30+ exchanges — ranked by ROI, Arena Score, and PnL.",
    images: [`${BASE_URL}/api/og?title=Arena&subtitle=All+rankings+in+crypto`],
    creator: '@arenafi',
    site: '@arenafi',
  },
  robots: { index: true, follow: true },
};

/**
 * Root layout — MINIMAL.
 * Only HTML structure, fonts, critical CSS, theme detection.
 * NO Providers — those are in (app)/layout.tsx for non-homepage pages.
 * Homepage loads zero Provider JS → LCP = FCP ≈ 1.5s.
 */
export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" dir="ltr" data-theme="dark" translate="no" className={inter.variable} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: `try{var l=localStorage.getItem('language');if(l&&l!=='zh')document.documentElement.lang=l==='en'?'en':l==='ja'?'ja':l==='ko'?'ko':'zh-CN'}catch(e){}` }} />
        <script dangerouslySetInnerHTML={{ __html: `try{var t=localStorage.getItem('theme');var e=t==='light'?'light':t==='dark'?'dark':window.matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light';document.documentElement.setAttribute('data-theme',e)}catch(x){}` }} />
        <script dangerouslySetInnerHTML={{ __html: `if(!AbortSignal.timeout){AbortSignal.timeout=function(ms){var c=new AbortController();setTimeout(function(){c.abort(new DOMException('TimeoutError','TimeoutError'))},ms);return c.signal}}` }} />
        <style dangerouslySetInnerHTML={{ __html: getCriticalCss() }} />
        {getResourceHints().map((hint, index) => (
          <link key={`resource-hint-${index}`} rel={hint.rel} href={hint.href} {...(hint.crossOrigin && { crossOrigin: hint.crossOrigin })} />
        ))}
        <script dangerouslySetInnerHTML={{ __html: `(function(){var a=document.createElement('link');a.rel='stylesheet';a.href='/styles/responsive.css';a.media='print';a.onload=function(){a.media='all'};document.head.appendChild(a)})()` }} />
        <noscript>
          {/* eslint-disable-next-line @next/next/no-css-tags */}
          <link rel="stylesheet" href="/styles/responsive.css" />
          {/* eslint-disable-next-line @next/next/no-css-tags */}
          <link rel="stylesheet" href="/styles/animations.css" />
        </noscript>
        <JsonLd data={{
          '@context': 'https://schema.org',
          '@type': 'WebSite',
          name: 'Arena',
          url: BASE_URL,
          description: 'Crypto trader rankings across 30+ exchanges.',
          potentialAction: {
            '@type': 'SearchAction',
            target: { '@type': 'EntryPoint', urlTemplate: `${BASE_URL}/?q={search_term_string}` },
            'query-input': 'required name=search_term_string',
          },
        }} />
        {/* Speculation Rules — pre-render likely navigation targets for near-zero LCP.
            Inspired by cal.com's SpeculationRules pattern. Chrome 121+ only;
            other browsers safely ignore the script type. */}
        <script type="speculationrules" dangerouslySetInnerHTML={{ __html: JSON.stringify({
          prerender: [{
            where: {
              and: [
                { href_matches: "/*" },
                { not: { href_matches: "/api/*" } },
                { not: { href_matches: "/auth/*" } },
                { not: { selector_matches: "[rel~=nofollow]" } },
              ]
            },
            eagerness: "moderate",
          }],
          prefetch: [{
            where: {
              and: [
                { href_matches: "/*" },
                { not: { href_matches: "/api/*" } },
              ]
            },
            eagerness: "moderate",
          }],
        }) }} />
      </head>
      <body
        className="font-sans antialiased"
        style={{ fontFamily: 'var(--font-inter), "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", system-ui, sans-serif' }}
        suppressHydrationWarning
      >
        <script dangerouslySetInnerHTML={{ __html: `(function(){var origInsert=Node.prototype.insertBefore;Node.prototype.insertBefore=function(n,r){if(r&&r.parentNode!==this)return n;return origInsert.call(this,n,r)};var origRemove=Node.prototype.removeChild;Node.prototype.removeChild=function(c){if(c.parentNode!==this)return c;return origRemove.call(this,c)}})()` }} />
        <main id="main-content" tabIndex={-1}>
          {children}
        </main>
      </body>
    </html>
  );
}
