# Performance Guide

This document consolidates all performance monitoring, optimization strategies, and implementation history for the Ranking Arena project.

**Last Updated**: 2026-01-28

---

## Table of Contents

1. [Web Vitals Monitoring](#web-vitals-monitoring)
2. [Font Optimization](#font-optimization)
3. [Image Optimization](#image-optimization)
4. [Code Splitting](#code-splitting)
5. [Caching Strategy](#caching-strategy)
6. [Implementation Record](#implementation-record)
7. [Optimization History](#optimization-history)
8. [Performance Targets](#performance-targets)
9. [Performance Checklist](#performance-checklist)

---

## Web Vitals Monitoring

Arena tracks Core Web Vitals using Next.js built-in `useReportWebVitals` hook in `app/components/Providers/WebVitals.tsx`.

### Monitored Metrics

| Metric | Description | Good | Poor |
|--------|-------------|------|------|
| **LCP** | Largest Contentful Paint | < 2.5s | > 4s |
| **FID** | First Input Delay | < 100ms | > 300ms |
| **CLS** | Cumulative Layout Shift | < 0.1 | > 0.25 |
| **FCP** | First Contentful Paint | < 1.8s | > 3s |
| **TTFB** | Time to First Byte | < 800ms | > 1.8s |
| **INP** | Interaction to Next Paint | < 200ms | > 500ms |

### Where Metrics Go

1. **Console logs** (development): Via `perfLogger` from `lib/utils/logger.ts`
2. **Sentry** (production): As distribution metrics with tags
3. **Custom endpoint**: If `NEXT_PUBLIC_ANALYTICS_ENDPOINT` is set

---

## Font Optimization

Fonts are loaded using `next/font/google` for automatic optimization:

```typescript
// app/layout.tsx
const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-inter",
  preload: true,
});

const notoSansSC = Noto_Sans_SC({
  subsets: ["latin"],
  weight: ["400", "700"],
  display: "swap",
  variable: "--font-noto-sans-sc",
  preload: false,
  adjustFontFallback: true,
});
```

Benefits:
- Automatic font file hosting on CDN
- Font subsetting to reduce file size
- `display: swap` prevents FOIT
- CSS variables for consistent usage
- Chinese font deferred with `preload: false`

---

## Image Optimization

Use Next.js `Image` component for automatic optimization:

```tsx
import Image from 'next/image'

<Image
  src="/avatar.png"
  alt="User avatar"
  width={40}
  height={40}
  priority={isAboveFold}
  loading={!isAboveFold ? "lazy" : undefined}
/>
```

### Optimized Avatar Component

A reusable `OptimizedAvatar` component is available at `app/components/ui/OptimizedAvatar.tsx`:

```tsx
import { OptimizedAvatar } from '@/app/components/ui/OptimizedAvatar'

<OptimizedAvatar
  userId={user.id}
  name={user.name}
  avatarUrl={user.avatar_url}
  size={48}
  priority={index < 3}
  index={index}
/>
```

Features: Next.js Image optimization, WebP/AVIF support, priority loading for first 3, blur placeholder, retina support (2x), error handling and fallback, skeleton component.

---

## Code Splitting

Use `next/dynamic` for lazy loading heavy components:

```tsx
import dynamic from 'next/dynamic'

const HeavyChart = dynamic(
  () => import('./HeavyChart'),
  {
    loading: () => <ChartSkeleton />,
    ssr: false
  }
)
```

### Current Lazy-Loaded Components

- `StatsBar` via `dynamic()` (ssr: false)
- `SidebarSection` via `dynamic()` (ssr: false)
- `CompareTraders` via `lazy()`
- Analytics tools (`WebVitals`, `SpeedInsights`) wrapped in `Suspense`

---

## Caching Strategy

### API Responses
- Use SWR for client-side data fetching with stale-while-revalidate
- Configure `refreshInterval` based on data freshness needs
- Use `dedupingInterval` to prevent duplicate requests

### Static Assets
- Next.js automatically sets cache headers
- Images: `immutable, max-age=31536000`
- JS/CSS chunks: content-hashed, long-term cacheable

### Server-Side Rendering
- ISR with `revalidate: 60` for homepage
- SSR data prefetching via `getInitialTraders()`
- Reduced initial trader count from 100 to 50

---

## Implementation Record

### Critical CSS Inlining (app/layout.tsx)

Inlined critical CSS for faster initial render using `getCriticalCss()` and `getResourceHints()` from `lib/performance/critical-css`.

**Impact**: FCP -200ms to -300ms, LCP -100ms to -200ms.

### Image Optimization (RankingTable)

Replaced native `<img>` with Next.js `Image` for ranking table avatars:
- WebP format (30-40% size reduction)
- Priority loading for first 3 avatars
- Retina support (2x sizing)
- Blur placeholder to prevent layout shift
- Lazy loading for below-fold images

**Impact**: Image load time -40% to -50%, LCP -300ms to -500ms, CLS near 0.

### Resource Preconnection (app/layout.tsx)

```html
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
<link rel="dns-prefetch" href="https://supabase.co" />
```

### Expected Results

| Metric | Before | After | Improvement |
|--------|--------|-------|-------------|
| FCP | ~1.5s | ~1.0s | -33% |
| LCP | ~2.5s | ~1.5s | -40% |
| CLS | ~0.15 | <0.05 | -67% |
| Image Size | ~100KB | ~60KB | -40% |

---

## Optimization History

### Early Optimization (76 files, 350+ issues)

- Fixed 50+ uses of `any` type for TypeScript safety
- Replaced 200+ console calls with unified logger
- Eliminated N+1 query problems using `.in()` batch queries
- Created 20+ database indexes
- Added XSS, SQL injection, CSRF, and rate limiting protections

### 30-Day Stabilization Plan (January 2026)

- Fixed database migration version conflicts
- Established CI pipeline (4 stages: pre-flight, lint/test, build, E2E)
- Documented all 113 API routes
- Added Stripe webhook idempotency
- Created message system tracing
- Documented all RLS policies for 15+ tables

### Phase 1 Cleanup

- Deleted 1 unused component (`PageTransition.tsx`, 99 lines)
- Reorganized 4 scripts into `scripts/setup/`
- Updated documentation references

---

## Performance Targets

| Metric | Target |
|--------|--------|
| LCP | < 1.5s |
| FID | < 50ms |
| CLS | < 0.1 |
| TTFB | < 200ms |
| FCP | < 1.0s |
| JS Bundle | < 350KB |
| API Response (P95) | < 200ms |

---

## Performance Checklist

- [ ] Images use `next/image` with appropriate sizing
- [ ] Large components are code-split with `dynamic`
- [ ] API calls use SWR with proper cache configuration
- [ ] Fonts use `next/font` for optimization
- [ ] Console.log replaced with structured logger
- [ ] Web Vitals are monitored in production
- [ ] Heavy computations are memoized
- [ ] Lists use virtualization for large datasets

### Verification

```bash
# Local
npm run build && npm start
node scripts/performance/measure-lcp.mjs http://localhost:3000

# Lighthouse
npx lighthouse https://your-staging-url.vercel.app --only-categories=performance
```

### Monitoring

- **Vercel Analytics**: Dashboard > Analytics > Web Vitals
- **Chrome DevTools**: Lighthouse audits, Performance panel
- **Sentry**: Error tracking with performance metrics

---

## Remaining Optimization Opportunities

### High Priority
1. Reduce initial JavaScript bundle (analyze with bundle analyzer)
2. Optimize additional image usage (exchange logos, other avatars)
3. Font subsetting for Chinese characters

### Medium Priority
4. Virtual scrolling for large lists (@tanstack/react-virtual)
5. Service Worker caching for critical resources
6. HTTP cache header optimization

### Low Priority
7. Edge Runtime for API routes
8. Partial Prerendering (PPR)
9. Predictive data prefetching

---

## References

- [Web Vitals](https://web.dev/vitals/)
- [Next.js Image Optimization](https://nextjs.org/docs/app/building-your-application/optimizing/images)
- [Critical CSS](https://web.dev/extract-critical-css/)
- [Resource Hints](https://www.w3.org/TR/resource-hints/)
- [Lighthouse Performance Scoring](https://web.dev/performance-scoring/)

---

> Consolidated from: PERFORMANCE.md, PERFORMANCE_IMPLEMENTATION.md, PERFORMANCE_OPTIMIZATION_SUMMARY.md, OPTIMIZATION_HISTORY.md
