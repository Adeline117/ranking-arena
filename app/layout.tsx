import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import KeyboardShortcuts from "./components/Utils/KeyboardShortcuts";
import { LanguageProvider } from "./components/Utils/LanguageProvider";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

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
  viewport: {
    width: 'device-width',
    initialScale: 1,
    maximumScale: 5,
    userScalable: true,
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" data-theme="dark">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <LanguageProvider>
          <KeyboardShortcuts />
          {children}
        </LanguageProvider>
      </body>
    </html>
  );
}
