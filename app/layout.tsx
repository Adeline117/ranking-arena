import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono, ZCOOL_KuaiLe } from "next/font/google";
import { Suspense } from "react";
import "./globals.css";
import KeyboardShortcuts from "./components/Utils/KeyboardShortcuts";
import Providers from "./components/Providers";
import { GlobalProgress } from "./components/UI/GlobalProgress";
import { ServiceWorkerRegistration } from "./components/Utils/ServiceWorkerRegistration";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// 站酷快乐体 - 用于中文 Logo
const zcoolKuaiLe = ZCOOL_KuaiLe({
  variable: "--font-logo-cn",
  weight: "400",
  subsets: ["latin"],
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
    default: "Ranking Arena · 加密交易员排行榜与社区",
    template: "%s · Ranking Arena",
  },
  description:
    "聚合 Binance/Bybit/Bitget/MEXC/CoinEx 等交易员 90 天 ROI 排行，支持关注、发帖与个人主页。",
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL || "https://www.arenafi.org"),
  applicationName: "Ranking Arena",
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
    title: "Ranking Arena",
  },
  formatDetection: {
    telephone: false,
  },
  openGraph: {
    type: "website",
    title: "Ranking Arena · 加密交易员排行榜与社区",
    description:
      "聚合多交易所 90 天 ROI 排行，实时更新，支持关注与发帖。",
    url: process.env.NEXT_PUBLIC_APP_URL || "https://www.arenafi.org",
    siteName: "Ranking Arena",
    images: [
      {
        url: "/og.png",
        width: 1200,
        height: 630,
        alt: "Ranking Arena",
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
        className={`${geistSans.variable} ${geistMono.variable} ${zcoolKuaiLe.variable} antialiased`}
      >
        <Providers>
          <ServiceWorkerRegistration />
          <Suspense fallback={null}>
            <GlobalProgress />
          </Suspense>
          <KeyboardShortcuts />
          {children}
        </Providers>
      </body>
    </html>
  );
}
