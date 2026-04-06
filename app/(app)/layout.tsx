import { Suspense } from "react";
import dynamic from "next/dynamic";
import Providers from "../components/Providers";
import CapacitorProvider from "../components/Providers/CapacitorProvider";
import { SkipLink } from "../components/Providers/Accessibility";
import { PageErrorBoundary } from "../components/utils/ErrorBoundary";
import BetaBanner from "../components/layout/BetaBanner";
import { AsyncStylesheets } from "../components/Providers/AsyncStylesheets";

const KeyboardShortcuts = dynamic(() => import("../components/Providers/KeyboardShortcuts"));
const GlobalProgress = dynamic(() => import("../components/ui/GlobalProgress").then(m => ({ default: m.GlobalProgress })));
const ServiceWorkerRegistration = dynamic(() => import("../components/Providers/ServiceWorkerRegistration").then(m => ({ default: m.ServiceWorkerRegistration })));
const CookieConsent = dynamic(() => import("../components/ui/CookieConsent"));
const CompareFloatingBar = dynamic(() => import("../components/trader/CompareFloatingBar"));
const ScrollToTop = dynamic(() => import("../components/ui/ScrollToTop"));
const ScrollRestoration = dynamic(() => import("../components/Providers/ScrollRestoration"));
const MobileBottomNav = dynamic(() => import("../components/layout/MobileBottomNav"));
const WebVitals = dynamic(() => import("../components/Providers/WebVitals").then(m => ({ default: m.WebVitals })));
const SpeedInsights = dynamic(() => import("@vercel/speed-insights/next").then(m => ({ default: m.SpeedInsights })));
const Analytics = dynamic(() => import("@vercel/analytics/next").then(m => ({ default: m.Analytics })));
const NetworkStatusBanner = dynamic(() => import("../components/ui/NetworkStatusBanner"));
const FeedbackWidget = dynamic(() => import("../components/common/FeedbackWidget"));
const PlausibleAnalytics = dynamic(() => import("../components/PlausibleAnalytics"));
const SentryInit = dynamic(() => import("../components/Providers/SentryInit"));

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
            <SentryInit />
            <NetworkStatusBanner />
            <ServiceWorkerRegistration />
            <KeyboardShortcuts />
            <CompareFloatingBar />
            <ScrollToTop />
            <FeedbackWidget />
            <PlausibleAnalytics />
            <ScrollRestoration />
            <CookieConsent />
          </Suspense>
        </CapacitorProvider>
      </Providers>
    </>
  );
}
