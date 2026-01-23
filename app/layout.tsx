import type { Metadata, Viewport } from "next";
import { Suspense } from "react";
import "./globals.css";
import KeyboardShortcuts from "./components/Providers/KeyboardShortcuts";
import Providers from "./components/Providers";
import { GlobalProgress } from "./components/ui/GlobalProgress";
import { ServiceWorkerRegistration } from "./components/Providers/ServiceWorkerRegistration";
import CookieConsent from "./components/ui/CookieConsent";
import { SkipLink } from "./components/Providers/Accessibility";

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
    default: "Arena · 加密交易员排行榜与社区",
    template: "%s · Arena",
  },
  description:
    "聚合 Binance/Bybit/Bitget/MEXC/CoinEx 等交易员 90 天 ROI 排行，支持关注、发帖与个人主页。",
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL || "https://www.arenafi.org"),
  applicationName: "Arena",
  keywords: [
    "Copy Trading",
    "Trader Ranking",
    "加密交易员",
    "ROI 排行",
    "跟单",
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
    title: "Arena · 加密交易员排行榜与社区",
    description:
      "聚合多交易所 90 天 ROI 排行，实时更新，支持关注与发帖。",
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
    <html lang="zh-CN" data-theme="dark" translate="no">
      <body
        className="font-sans antialiased"
      >
        <Providers>
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
        </Providers>
      </body>
    </html>
  );
}
