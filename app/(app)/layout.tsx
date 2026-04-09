import { Suspense } from "react";
import dynamic from "next/dynamic";
import Providers from "../components/Providers";
import CapacitorProvider from "../components/Providers/CapacitorProvider";
import { SkipLink } from "../components/Providers/Accessibility";
import { PageErrorBoundary } from "../components/utils/ErrorBoundary";
import BetaBanner from "../components/layout/BetaBanner";
import { AsyncStylesheets } from "../components/Providers/AsyncStylesheets";

// GlobalProgress / MobileBottomNav stay separate — needed sooner after mount
// for navigation responsiveness.
const GlobalProgress = dynamic(() => import("../components/ui/GlobalProgress").then(m => ({ default: m.GlobalProgress })));
const MobileBottomNav = dynamic(() => import("../components/layout/MobileBottomNav"));
// Vercel Analytics / WebVitals stay separate because they're loaded from
// node_modules chunks that webpack may split differently.
const WebVitals = dynamic(() => import("../components/Providers/WebVitals").then(m => ({ default: m.WebVitals })));
const SpeedInsights = dynamic(() => import("@vercel/speed-insights/next").then(m => ({ default: m.SpeedInsights })));
const Analytics = dynamic(() => import("@vercel/analytics/next").then(m => ({ default: m.Analytics })));
// DeferredLayoutWidgets groups 10 non-critical widgets (Sentry, network
// banner, SW, keyboard shortcuts, compare bar, scroll-to-top, feedback,
// Plausible, scroll restoration, cookie consent) into a SINGLE async chunk
// instead of 10 separate ones — saves ~100-300ms of chunk negotiation on 4G.
const DeferredLayoutWidgets = dynamic(() => import("../components/layout/DeferredLayoutWidgets"));

/**
 * App layout — wraps ALL pages except the homepage.
 * Includes Providers, TopNav, sidebars, analytics, etc.
 * Homepage uses the root layout directly (no Providers) for minimal JS / instant LCP.
 */
export default function AppLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <>
      <AsyncStylesheets />
      <Providers>
        <CapacitorProvider>
          <Suspense fallback={null}>
            <WebVitals />
            <SpeedInsights />
            <Analytics />
          </Suspense>
          <SkipLink targetId="main-content" />
          <Suspense fallback={null}>
            <GlobalProgress />
          </Suspense>
          <BetaBanner />
          <PageErrorBoundary>
            <main id="main-content" tabIndex={-1}>
              {children}
            </main>
          </PageErrorBoundary>
          <MobileBottomNav />
          <Suspense fallback={null}>
            <DeferredLayoutWidgets />
          </Suspense>
        </CapacitorProvider>
      </Providers>
    </>
  );
}
