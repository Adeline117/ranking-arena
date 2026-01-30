import type { Metadata, Viewport } from "next";
import { Suspense } from "react";
import { Inter } from "next/font/google";
import "./globals.css";
import dynamic from "next/dynamic";
import Providers from "./components/Providers";
import CapacitorProvider from "./components/Providers/CapacitorProvider";
import { SkipLink } from "./components/Providers/Accessibility";

// Defer non-critical layout components via dynamic import (code-split)
// Note: ssr:false not allowed in Server Components; these are 'use client' components
// and will only hydrate on the client
const KeyboardShortcuts = dynamic(() => import("./components/Providers/KeyboardShortcuts"));
const GlobalProgress = dynamic(() => import("./components/ui/GlobalProgress").then(m => ({ default: m.GlobalProgress })));
const ServiceWorkerRegistration = dynamic(() => import("./components/Providers/ServiceWorkerRegistration").then(m => ({ default: m.ServiceWorkerRegistration })));
const CookieConsent = dynamic(() => import("./components/ui/CookieConsent"));
const WebVitals = dynamic(() => import("./components/Providers/WebVitals").then(m => ({ default: m.WebVitals })));
const SpeedInsights = dynamic(() => import("@vercel/speed-insights/next").then(m => ({ default: m.SpeedInsights })));
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
  themeColor: [
    { media: '(prefers-color-scheme: dark)', color: '#0B0A10' },
    { media: '(prefers-color-scheme: light)', color: '#FFFFFF' },
  ],
};

export const metadata: Metadata = {
  title: {
    default: "Arena · Crypto Trader Leaderboard & Community",
    template: "%s · Arena",
  },
  description:
    "Aggregating 90-day ROI rankings from Binance, Bybit, Bitget, MEXC, OKX, KuCoin, CoinEx, GMX and more. Follow top traders and join the community.",
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL || "https://www.arenafi.org"),
  applicationName: "Arena",
  keywords: [
    "Copy Trading",
    "Trader Ranking",
    "Crypto Traders",
    "ROI Leaderboard",
    "Trading Community",
  ],
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Arena",
  },
  formatDetection: {
    telephone: false,
  },
  openGraph: {
    type: "website",
    title: "Arena · Crypto Trader Leaderboard & Community",
    description:
      "Aggregating 90-day ROI rankings from multiple exchanges. Real-time updates, follow traders and share insights.",
    url: process.env.NEXT_PUBLIC_APP_URL || "https://www.arenafi.org",
    siteName: "Arena",
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
    <html lang="en" data-theme="dark" translate="no" className={inter.variable}>
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

        {/* Preload critical API endpoint for faster data fetch */}
        <link rel="preconnect" href={process.env.NEXT_PUBLIC_APP_URL || "https://www.arenafi.org"} />

        {/* Font preloading is handled automatically by next/font.
            Removed hardcoded preload link — the hashed filename (e.g. be2afef9-s.woff2)
            never matched the static path, so this was a wasted network request. */}

        {/* Non-critical CSS loaded via AsyncStylesheets component after hydration */}
        <noscript>
          <link rel="stylesheet" href="/styles/responsive.css" />
          <link rel="stylesheet" href="/styles/animations.css" />
        </noscript>
      </head>
      <body
        className="font-sans antialiased"
        style={{ fontFamily: 'var(--font-inter), "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", system-ui, sans-serif' }}
      >
        <Providers>
          <CapacitorProvider>
            {/* Load non-critical CSS after hydration */}
            <AsyncStylesheets />
            {/* Analytics deferred via dynamic import */}
            <WebVitals />
            <SpeedInsights />
            <SkipLink targetId="main-content" />
            <ServiceWorkerRegistration />
            <Suspense fallback={null}>
              <GlobalProgress />
            </Suspense>
            <KeyboardShortcuts />
            <main id="main-content" tabIndex={-1}>
              {children}
            </main>
            <CookieConsent />
          </CapacitorProvider>
        </Providers>
      </body>
    </html>
  );
}
