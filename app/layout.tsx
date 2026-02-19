import type { Metadata, Viewport } from "next";
import { Suspense } from "react";
import { Inter } from "next/font/google";
import "./globals.css";
import dynamic from "next/dynamic";
import Providers from "./components/Providers";
import CapacitorProvider from "./components/Providers/CapacitorProvider";
import { SkipLink } from "./components/Providers/Accessibility";
import { PageErrorBoundary } from "./components/utils/ErrorBoundary";

// Defer non-critical layout components via dynamic import (code-split)
// Note: ssr:false not allowed in Server Components; these are 'use client' components
// and will only hydrate on the client
const KeyboardShortcuts = dynamic(() => import("./components/Providers/KeyboardShortcuts"));
const GlobalProgress = dynamic(() => import("./components/ui/GlobalProgress").then(m => ({ default: m.GlobalProgress })));
const ServiceWorkerRegistration = dynamic(() => import("./components/Providers/ServiceWorkerRegistration").then(m => ({ default: m.ServiceWorkerRegistration })));
// Removed: CookieConsent, WelcomeGuide, InstallPrompt — 用户进来直接用
// WelcomeGuide removed
const CompareFloatingBar = dynamic(() => import("./components/trader/CompareFloatingBar"));
const ScrollToTop = dynamic(() => import("./components/ui/ScrollToTop"));
const MobileBottomNav = dynamic(() => import("./components/layout/MobileBottomNav"));
// InstallPrompt removed
const WebVitals = dynamic(() => import("./components/Providers/WebVitals").then(m => ({ default: m.WebVitals })));
const SpeedInsights = dynamic(() => import("@vercel/speed-insights/next").then(m => ({ default: m.SpeedInsights })));
const Analytics = dynamic(() => import("@vercel/analytics/next").then(m => ({ default: m.Analytics })));
const NetworkStatusBanner = dynamic(() => import("./components/ui/NetworkStatusBanner"));
import { getCriticalCss, getResourceHints } from "@/lib/performance/critical-css";
import { AsyncStylesheets } from "./components/Providers/AsyncStylesheets";

// Optimized font loading with next/font
const inter = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],  // Only load weights used by design-tokens.ts (saves ~180KB)
  display: "swap",
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
    default: "Arena",
    template: "%s | Arena",
  },
  description:
    "Enter. Outperform. | 入场，超越。Arena aggregates trader rankings from 30+ exchanges. Follow top traders, share insights, and level up your trading.",
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL || "https://www.arenafi.org"),
  applicationName: "Arena",
  keywords: [
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
    canonical: process.env.NEXT_PUBLIC_APP_URL || "https://www.arenafi.org",
    languages: {
      'zh-CN': process.env.NEXT_PUBLIC_APP_URL || "https://www.arenafi.org",
      'en': `${process.env.NEXT_PUBLIC_APP_URL || "https://www.arenafi.org"}/en`,
    },
  },
  openGraph: {
    type: "website",
    title: "Arena — Enter. Outperform.",
    description:
      "Enter. Outperform. Arena aggregates trader rankings from 30+ exchanges. Follow top traders, share insights, and level up your trading.",
    url: process.env.NEXT_PUBLIC_APP_URL || "https://www.arenafi.org",
    siteName: "Arena",
    locale: "zh_CN",
    images: [
      {
        url: `${process.env.NEXT_PUBLIC_APP_URL || "https://www.arenafi.org"}/og-image.png`,
        width: 1200,
        height: 630,
        alt: "Arena - 加密货币交易员排行榜",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Arena — Enter. Outperform.",
    description:
      "Enter. Outperform. Arena aggregates trader rankings from 30+ exchanges. Follow top traders and level up your trading.",
    images: [
      `${process.env.NEXT_PUBLIC_APP_URL || "https://www.arenafi.org"}/og-image.png`,
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
    <html lang="zh-CN" dir="ltr" data-theme="dark" translate="no" className={inter.variable} suppressHydrationWarning>
      <head>
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
        <link rel="preconnect" href="https://assets.coingecko.com" />
        <link rel="preconnect" href="https://iknktzifjdyujdccyhsv.supabase.co" />
        <link rel="dns-prefetch" href="https://iknktzifjdyujdccyhsv.supabase.co" />
        
        {/* Font preloading is handled automatically by next/font.
            Removed hardcoded preload link — the hashed filename (e.g. be2afef9-s.woff2)
            never matched the static path, so this was a wasted network request. */}

        {/* Non-critical CSS loaded via AsyncStylesheets component after hydration */}
        <noscript>
          {/* eslint-disable-next-line @next/next/no-css-tags */}
          <link rel="stylesheet" href="/styles/responsive.css" />
          {/* eslint-disable-next-line @next/next/no-css-tags */}
          <link rel="stylesheet" href="/styles/animations.css" />
        </noscript>
      </head>
      <body
        className="font-sans antialiased"
        style={{ fontFamily: 'var(--font-inter), "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", system-ui, sans-serif' }}
        suppressHydrationWarning
      >
        <Providers>
          <CapacitorProvider>
            {/* Load non-critical CSS after hydration */}
            <AsyncStylesheets />
            {/* Analytics deferred via dynamic import */}
            <WebVitals />
            <SpeedInsights />
            <Analytics />
            <NetworkStatusBanner />
            <SkipLink targetId="main-content" />
            <ServiceWorkerRegistration />
            <Suspense fallback={null}>
              <GlobalProgress />
            </Suspense>
            <KeyboardShortcuts />
            <PageErrorBoundary>
              <main id="main-content" tabIndex={-1} style={{ viewTransitionName: 'page-content' }}>
                {children}
              </main>
            </PageErrorBoundary>
            <MobileBottomNav />
            <CompareFloatingBar />
            <ScrollToTop />
          </CapacitorProvider>
        </Providers>
      </body>
    </html>
  );
}
