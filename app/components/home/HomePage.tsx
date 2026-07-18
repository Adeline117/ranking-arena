'use client'

import { Suspense, lazy } from 'react'
import { tokens } from '@/lib/design-tokens'
import ThreeColumnLayout from '../layout/ThreeColumnLayout'
const MobileBottomNav = lazy(() => import('../layout/MobileBottomNav'))
const Footer = lazy(() => import('../layout/Footer'))
const FoundingMemberBanner = lazy(() => import('./FoundingMemberBanner'))
const ExchangePartners = lazy(() => import('./ExchangePartners'))
// HomeHero REMOVED from Phase 2 — SSR hero (HomeHeroSSR) stays visible permanently
// as the LCP element. Rendering Phase 2 hero created a new LCP paint at ~10s.
// WelcomeModal removed — blocks entire page for first-time visitors
import HomePageClient from './HomePageClient'
import { SectionErrorBoundary } from '../utils/ErrorBoundary'
import DeferredMount from '../utils/DeferredMount'
// RankingSkeleton removed from Phase 2 — see SSR comment above
import { features } from '@/lib/features'
import enFull from '@/lib/i18n/en'
import { registerFullDict } from '@/lib/i18n'
// Lazy-load sidebar widgets
const HotDiscussions = lazy(() => import('../sidebar/HotDiscussions'))
const WatchlistMarket = lazy(() => import('../sidebar/WatchlistMarket'))
const NewsFlash = lazy(() => import('../sidebar/NewsFlash'))
const TrendingHashtags = lazy(() => import('../sidebar/TrendingHashtags'))

// HomePage is already a deferred Phase-2 chunk. Register the full English
// dictionary in that same chunk before rendering it so slow connections never
// expose raw keys such as "sidebarHotDiscussions" while a second i18n chunk
// catches up. This does not increase the provider-light server shell or its LCP.
registerFullDict('en', enFull)

// PERF P1-PERF-2 (audit): stagger widget mounts so each widget's SWR fetch
// fires on a different tick, preventing the simultaneous 4-way network burst
// that competes with the LCP repaint. Watchlist is highest priority (renders
// in the right column where the user looks first), so it gets 0ms delay.
// Others stagger by ~800ms each. Total spread: 0 → 2400ms which is well
// under any reasonable user-first-interaction window.
const WIDGET_DELAYS = {
  watchlist: 0, // first to mount — most visible above the fold
  hotDiscussions: 800, // left column, social, secondary priority
  trendingHashtags: 1600,
  newsFlash: 2400, // bottom of right column, lowest priority
}

import type { InitialTrader, CategoryCounts } from '@/lib/getInitialTraders'

interface HomePageProps {
  initialTraders?: InitialTrader[]
  initialLastUpdated?: string | null
  heroStats?: { traderCount: number; exchangeCount: number }
  initialTotalCount?: number
  initialCategoryCounts?: CategoryCounts
}

export default function HomePage({
  initialTraders,
  initialLastUpdated,
  heroStats: _heroStats,
  initialTotalCount,
  initialCategoryCounts,
}: HomePageProps) {
  // SSR TopNav stays visible permanently (no portal, no removal).
  // globals.css no longer hides #ssr-topnav when Phase 2 loads.

  // SSR shell hiding moved to HomePageClient.tsx — only hides when data is ready.

  return (
    <>
      <div id="homepage-interactive" suppressHydrationWarning className="home-page-root">
        <div className="container-padding has-mobile-nav home-page-container">
          {/* Phase 2 hero REMOVED — SSR hero stays visible permanently as LCP element.
            Rendering a Phase 2 hero would paint a new large element at ~10s on slow 4G,
            resetting LCP from 1.2s to 10s. SSR hero is identical visual content. */}
          <div className="contain-content">
            <Suspense fallback={null}>
              <FoundingMemberBanner />
            </Suspense>
          </div>
          {/* Keep the desktop discovery surface in its established three-column
              layout: social context left, rankings center, market context right. */}
          <Suspense
            fallback={
              <div
                className="contain-layout-style"
                style={{ height: 47, borderBottom: '1px solid var(--color-border-primary)' }}
              />
            }
          >
            <ExchangePartners />
          </Suspense>
          <ThreeColumnLayout
            leftSidebar={
              features.social ? (
                <SectionErrorBoundary>
                  <DeferredMount
                    delayMs={WIDGET_DELAYS.hotDiscussions}
                    fallback={
                      <div
                        className="skeleton contain-layout-style"
                        style={{ minHeight: 400, borderRadius: tokens.radius.lg }}
                      />
                    }
                  >
                    <Suspense
                      fallback={
                        <div
                          className="skeleton contain-layout-style"
                          style={{ minHeight: 400, borderRadius: tokens.radius.lg }}
                        />
                      }
                    >
                      <HotDiscussions />
                    </Suspense>
                  </DeferredMount>
                </SectionErrorBoundary>
              ) : null
            }
            rightSidebar={
              <div
                className="contain-layout-style"
                style={{ display: 'flex', flexDirection: 'column', gap: 16 }}
              >
                <div style={{ flexShrink: 0 }}>
                  <SectionErrorBoundary>
                    <DeferredMount
                      delayMs={WIDGET_DELAYS.watchlist}
                      fallback={
                        <div
                          className="skeleton contain-layout-style"
                          style={{ minHeight: 200, borderRadius: tokens.radius.lg }}
                        />
                      }
                    >
                      <Suspense
                        fallback={
                          <div
                            className="skeleton contain-layout-style"
                            style={{ minHeight: 200, borderRadius: tokens.radius.lg }}
                          />
                        }
                      >
                        <WatchlistMarket />
                      </Suspense>
                    </DeferredMount>
                  </SectionErrorBoundary>
                </div>
                {features.social && (
                  <div style={{ flexShrink: 0 }}>
                    <SectionErrorBoundary>
                      <DeferredMount
                        delayMs={WIDGET_DELAYS.trendingHashtags}
                        fallback={
                          <div
                            className="skeleton contain-layout-style"
                            style={{ minHeight: 120, borderRadius: tokens.radius.lg }}
                          />
                        }
                      >
                        <Suspense
                          fallback={
                            <div
                              className="skeleton contain-layout-style"
                              style={{ minHeight: 120, borderRadius: tokens.radius.lg }}
                            />
                          }
                        >
                          <TrendingHashtags />
                        </Suspense>
                      </DeferredMount>
                    </SectionErrorBoundary>
                  </div>
                )}
                <div style={{ flex: 1, minHeight: 0 }}>
                  <SectionErrorBoundary>
                    <DeferredMount
                      delayMs={WIDGET_DELAYS.newsFlash}
                      fallback={
                        <div
                          className="skeleton contain-layout-style"
                          style={{ minHeight: 300, borderRadius: tokens.radius.lg }}
                        />
                      }
                    >
                      <Suspense
                        fallback={
                          <div
                            className="skeleton contain-layout-style"
                            style={{ minHeight: 300, borderRadius: tokens.radius.lg }}
                          />
                        }
                      >
                        <NewsFlash />
                      </Suspense>
                    </DeferredMount>
                  </SectionErrorBoundary>
                </div>
              </div>
            }
          >
            <SectionErrorBoundary>
              {/* No Suspense wrapper — HomePageClient is statically imported (not lazy),
                  so its code is already in the main bundle. Wrapping in Suspense caused
                  the "spinner of death" on mobile: during hydration, Suspense showed
                  <RankingSkeleton> which replaced the visible SSR content with a skeleton,
                  then CSS :has() hid #ssr-ranking-table, leaving users staring at a
                  spinner while 4.2MB JS loaded. Without Suspense, React hydrates
                  HomePageClient in-place and SSR content stays visible throughout. */}
              <HomePageClient
                initialTraders={initialTraders}
                initialLastUpdated={initialLastUpdated}
                initialTotalCount={initialTotalCount}
                initialCategoryCounts={initialCategoryCounts}
              />
            </SectionErrorBoundary>
          </ThreeColumnLayout>
        </div>

        <div className="contain-content">
          <Suspense fallback={<div style={{ minHeight: 200 }} />}>
            <Footer />
          </Suspense>
        </div>
        <Suspense fallback={null}>
          <MobileBottomNav />
        </Suspense>
        {/* WelcomeModal removed — homepage content IS the onboarding */}
      </div>
    </>
  )
}
