import type { Metadata, Viewport } from "next";
import { Suspense } from "react";
import { Inter, Noto_Sans_SC } from "next/font/google";
import "./globals.css";
import KeyboardShortcuts from "./components/Providers/KeyboardShortcuts";
import Providers from "./components/Providers";
import CapacitorProvider from "./components/Providers/CapacitorProvider";
import { GlobalProgress } from "./components/ui/GlobalProgress";
import { ServiceWorkerRegistration } from "./components/Providers/ServiceWorkerRegistration";
import CookieConsent from "./components/ui/CookieConsent";
import { SkipLink } from "./components/Providers/Accessibility";
import { WebVitals } from "./components/Providers/WebVitals";
import { SpeedInsights } from "@vercel/speed-insights/next";

// Optimized font loading with next/font
const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-inter",
  preload: true,
});

const notoSansSC = Noto_Sans_SC({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
  variable: "--font-noto-sans-sc",
  preload: true,
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
    images: [
      {
        url: "/og.png",
        width: 1200,
        height: 630,
        alt: "Arena",
      },
    ],
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
    <html lang="en" data-theme="dark" translate="no" className={`${inter.variable} ${notoSansSC.variable}`}>
      <body
        className="font-sans antialiased"
        style={{ fontFamily: 'var(--font-inter), var(--font-noto-sans-sc), system-ui, sans-serif' }}
      >
        <Providers>
          <CapacitorProvider>
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
