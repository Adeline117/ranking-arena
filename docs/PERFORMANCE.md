# Performance Guide

This document covers performance monitoring and optimization practices for Arena.

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
  weight: ["400", "500", "600", "700"],
  display: "swap",
  variable: "--font-noto-sans-sc",
  preload: true,
});
```

Benefits:
- Automatic font file hosting on CDN
- Font subsetting to reduce file size
- `display: swap` prevents FOIT
- CSS variables for consistent usage

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

## Caching Strategy

### API Responses
- Use SWR for client-side data fetching with stale-while-revalidate
- Configure `refreshInterval` based on data freshness needs
- Use `dedupingInterval` to prevent duplicate requests

### Static Assets
- Next.js automatically sets cache headers
- Images: `immutable, max-age=31536000`
- JS/CSS chunks: content-hashed, long-term cacheable

## Logging

Use the structured logger from `lib/utils/logger.ts`:

```typescript
import { perfLogger, createTimer } from '@/lib/utils/logger'

// Timing operations
const timer = createTimer('api-fetch', 'Traders')
const data = await fetchTraders()
timer.end({ status: 200 })

// Performance warnings
perfLogger.warn('Slow render detected', { component: 'RankingTable', ms: 150 })
```

The logger automatically:
- Suppresses debug/log in production
- Shows warn/error in all environments
- Integrates with Sentry for error tracking

## Performance Checklist

- [ ] Images use `next/image` with appropriate sizing
- [ ] Large components are code-split with `dynamic`
- [ ] API calls use SWR with proper cache configuration
- [ ] Fonts use `next/font` for optimization
- [ ] Console.log replaced with structured logger
- [ ] Web Vitals are monitored in production
- [ ] Heavy computations are memoized
- [ ] Lists use virtualization for large datasets
