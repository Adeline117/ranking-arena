import type { Metadata, Viewport } from "next";
import { Suspense } from "react";
import { Inter } from "next/font/google";
import "./globals.css";
import dynamic from "next/dynamic";
import Providers from "./components/Providers";
import CapacitorProvider from "./components/Providers/CapacitorProvider";
import { SkipLink } from "./components/Providers/Accessibility";
import { PageErrorBoundary } from "./components/utils/ErrorBoundary";
import { JsonLd } from "./components/Providers/JsonLd";
import { BASE_URL } from "@/lib/constants/urls";

// Defer non-critical layout components via dynamic import (code-split)
// Note: ssr:false not allowed in Server Components (layout.tsx is a Server Component)
const KeyboardShortcuts = dynamic(() => import("./components/Providers/KeyboardShortcuts"));
const GlobalProgress = dynamic(() => import("./components/ui/GlobalProgress").then(m => ({ default: m.GlobalProgress })));
const ServiceWorkerRegistration = dynamic(() => import("./components/Providers/ServiceWorkerRegistration").then(m => ({ default: m.ServiceWorkerRegistration })));
// WelcomeGuide removed
const CookieConsent = dynamic(() => import("./components/ui/CookieConsent"));
const CompareFloatingBar = dynamic(() => import("./components/trader/CompareFloatingBar"));
const ScrollToTop = dynamic(() => import("./components/ui/ScrollToTop"));
const ScrollRestoration = dynamic(() => import("./components/Providers/ScrollRestoration"));
const MobileBottomNav = dynamic(() => import("./components/layout/MobileBottomNav"));
// InstallPrompt removed
const WebVitals = dynamic(() => import("./components/Providers/WebVitals").then(m => ({ default: m.WebVitals })));
const SpeedInsights = dynamic(() => import("@vercel/speed-insights/next").then(m => ({ default: m.SpeedInsights })));
const Analytics = dynamic(() => import("@vercel/analytics/next").then(m => ({ default: m.Analytics })));
const NetworkStatusBanner = dynamic(() => import("./components/ui/NetworkStatusBanner"));
const BetaBanner = dynamic(() => import("./components/layout/BetaBanner"));
const FeedbackWidget = dynamic(() => import("./components/common/FeedbackWidget"));
const PlausibleAnalytics = dynamic(() => import("./components/PlausibleAnalytics"));
import { getCriticalCss, getResourceHints } from "@/lib/performance/critical-css";
import { AsyncStylesheets } from "./components/Providers/AsyncStylesheets";

// Optimized font loading — 2 weights instead of 4 saves ~90KB, 'optional' avoids font-swap LCP delay
const inter = Inter({
  subsets: ["latin"],
  weight: ["400", "600"],  // 400=normal, 600=semibold (covers all design-token needs, 500/700 unnecessary)
  display: "optional",  // "optional" skips font if not loaded in ~100ms — avoids LCP delay from font swap
  variable: "--font-inter",
  preload: true,
  adjustFontFallback: true,
});


export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
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
    "crypto trader ranking",
    "crypto leaderboard",
    "copy trading",
    "best crypto traders",
    "binance trader ranking",
    "hyperliquid leaderboard",
    "crypto ROI ranking",
    "top crypto traders 2024",
    "跟单交易",
    "交易员排行榜",
    "加密货币交易员",
    "ROI排行",
    "交易社区",
    "Copy Trading",
    "Trader Ranking",
    "Crypto Leaderboard",
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
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Arena",
  },
  formatDetection: {
    telephone: false,
  },
  alternates: {
    canonical: BASE_URL,
    // No per-language URLs — language is client-side only (localStorage)
    // Removed invalid /en hreflang (no /en route exists)
  },
  openGraph: {
    type: "website",
    title: "Arena ranks everything in crypto",
    description:
      "All rankings in crypto. Arena tracks top traders from Binance, Bybit, OKX, Hyperliquid, and 30+ exchanges — ranked by ROI, Arena Score, and PnL.",
    url: BASE_URL,
    siteName: "Arena",
    locale: "en_US",
    images: [
      {
        url: `${BASE_URL}/api/og?title=Arena&subtitle=All+rankings+in+crypto`,
        width: 1200,
        height: 630,
        alt: "Arena — All Rankings in Crypto",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Arena ranks everything in crypto",
    description:
      "All rankings in crypto. Arena tracks top traders from Binance, Bybit, OKX, Hyperliquid, and 30+ exchanges — ranked by ROI, Arena Score, and PnL.",
    images: [
      `${BASE_URL}/api/og?title=Arena&subtitle=All+rankings+in+crypto`,
    ],
    creator: '@arenafi',
  },
  robots: {
    index: true,
    follow: true,
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" dir="ltr" data-theme="dark" translate="no" className={inter.variable} suppressHydrationWarning>
      <head>
        {/* Sync html lang attribute from localStorage before paint (prevents wrong lang for screen readers) */}
        <script dangerouslySetInnerHTML={{ __html: `try{var l=localStorage.getItem('language');if(l&&l!=='zh')document.documentElement.lang=l==='en'?'en':l==='ja'?'ja':l==='ko'?'ko':'zh-CN'}catch(e){/* localStorage unavailable */}` }} />
        {/* Inline critical CSS for faster initial render */}
        <style dangerouslySetInnerHTML={{ __html: getCriticalCss() }} />

        {/* Resource hints for external resources */}
        {getResourceHints().map((hint, index) => (
          <link
            key={`resource-hint-${index}`}
            rel={hint.rel}
            href={hint.href}
            {...(hint.crossOrigin && { crossOrigin: hint.crossOrigin })}
          />
        ))}

        {/* Preload critical above-fold resources for LCP */}
        <link rel="preload" href="/logo-symbol-56.png" as="image" type="image/png" />
        {/* Removed redundant preconnect/dns-prefetch hints:
            - Supabase preconnect already in getResourceHints()
            - CoinGecko assets fetched server-side, not from browser
            Keeping only the 2 preconnects from getResourceHints(): Supabase + CDN */}
        
        {/* Font preloading is handled automatically by next/font.
            Removed hardcoded preload link — the hashed filename (e.g. be2afef9-s.woff2)
            never matched the static path, so this was a wasted network request. */}

        {/* Non-critical CSS loaded via AsyncStylesheets component after hydration */}
        <noscript>
          {/* eslint-disable-next-line @next/next/no-css-tags -- noscript fallback requires static CSS link tags */}
          <link rel="stylesheet" href="/styles/responsive.css" />
          {/* eslint-disable-next-line @next/next/no-css-tags -- noscript fallback requires static CSS link tags */}
          <link rel="stylesheet" href="/styles/animations.css" />
        </noscript>

        {/* WebSite structured data — helps Google understand sitelinks search box */}
        <JsonLd data={{
          '@context': 'https://schema.org',
          '@type': 'WebSite',
          name: 'Arena',
          url: BASE_URL,
          description: 'Crypto trader rankings across 30+ exchanges — Binance, Bybit, OKX, Hyperliquid and more.',
          potentialAction: {
            '@type': 'SearchAction',
            target: { '@type': 'EntryPoint', urlTemplate: `${BASE_URL}/?q={search_term_string}` },
            'query-input': 'required name=search_term_string',
          },
        }} />
      </head>
      <body
        className="font-sans antialiased"
        style={{ fontFamily: 'var(--font-inter), "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", system-ui, sans-serif' }}
        suppressHydrationWarning
      >
        {/* Load non-critical CSS early — outside Providers to avoid waiting for hydration */}
        <AsyncStylesheets />
        <Providers>
          <CapacitorProvider>
            {/* Analytics deferred: loaded after LCP via Suspense */}
            <Suspense fallback={null}>
              <WebVitals />
              <SpeedInsights />
              <Analytics />
            </Suspense>
            <BetaBanner />
            <NetworkStatusBanner />
            <SkipLink targetId="main-content" />
            <ServiceWorkerRegistration />
            <Suspense fallback={null}>
              <GlobalProgress />
            </Suspense>
            <KeyboardShortcuts />
            <PageErrorBoundary>
              <main id="main-content" tabIndex={-1}>
                {children}
              </main>
            </PageErrorBoundary>
            <MobileBottomNav />
            <CompareFloatingBar />
            <ScrollToTop />
            <FeedbackWidget />
            <PlausibleAnalytics />
            <ScrollRestoration />
            <Suspense fallback={null}>
              <CookieConsent />
            </Suspense>
          </CapacitorProvider>
        </Providers>
      </body>
    </html>
  );
}
