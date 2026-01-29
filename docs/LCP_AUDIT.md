# LCP Performance Audit Report

**Date**: 2025-07-29  
**Project**: Ranking Arena (Next.js 16.1.6 + React 19.2.3)  
**Build Tool**: Webpack  
**Homepage Route**: `/` (ISR, revalidate: 30s)

---

## Executive Summary

The project has a solid performance foundation — ISR, server-side data fetching, critical CSS inlining, async stylesheet loading, and Suspense streaming are all in place. However, several issues inflate the client JS bundle and block LCP unnecessarily.

**Estimated LCP budget** (homepage, 4G mobile):
| Asset | Size (uncompressed) | Gzipped (est.) | Status |
|-------|-------|--------|--------|
| Framework (React) | 185 KB | ~60 KB | ✅ Required |
| Next.js Router Runtime | 619 KB | ~180 KB | ⚠️ Large but required |
| main.js | 559 KB | ~160 KB | ⚠️ Large |
| Supabase Client | 191 KB | ~55 KB | ⚠️ On critical path |
| Sentry Client | 115 KB | ~35 KB | ⚠️ Not needed for LCP |
| Polyfills | 110 KB | ~35 KB | ⚠️ Could be conditional |
| layout.js | 49 KB | ~15 KB | ✅ OK |
| page.js (homepage) | 88 KB | ~28 KB | ✅ OK |
| **Fonts (108 woff2)** | **4.7 MB** | **N/A** | 🔴 Noto Sans SC bloat |

**Total JS for homepage**: ~1.9 MB uncompressed, ~570 KB gzipped (estimate)

---

## ✅ What's Working Well

### 1. ISR with Server-Side Data Fetching
```
// app/page.tsx — Server Component
export const revalidate = 30
const { traders } = await getInitialTraders('90D', 50)
```
- Homepage is statically generated with 30s ISR revalidation
- Data fetched server-side eliminates client waterfall
- Suspense wraps HomePage with RankingTableSkeleton fallback

### 2. Critical CSS Inlining
- `lib/performance/critical-css.ts` inlines ~6KB of critical CSS in `<head>`
- Covers layout grid, dark/light themes, skeleton animations, responsive breakpoints
- Non-critical CSS (`responsive.css`, `animations.css`) loaded via `requestIdleCallback`

### 3. Font Loading via next/font
- `Inter` and `Noto Sans SC` loaded through `next/font/google`
- `display: "swap"` prevents invisible text
- `adjustFontFallback: true` reduces CLS

### 4. Suspense Streaming Architecture
- `HomePage.tsx` (Server Component) streams sidebars in separate Suspense boundaries
- WebVitals and SpeedInsights wrapped in `<Suspense fallback={null}>`
- GlobalProgress deferred with Suspense

### 5. Sentry Server-Only Init
- `instrumentation.ts` only imports Sentry on `nodejs` and `edge` runtimes
- No `sentry.client.config.ts` found — client Sentry is loaded on demand
- `bundleSizeOptimizations.excludeDebugStatements: true` strips debug logs

### 6. Dynamic Imports in TopNav
```typescript
const MobileSearchOverlay = dynamic(() => import('...'), { ssr: false })
const AccountSwitcher = dynamic(() => import('...'), { ssr: false })
const InboxPanel = dynamic(() => import('...'), { ssr: false })
```

---

## 🔴 Critical Issues

### C1. Broken Font Preload Link
**File**: `app/layout.tsx` line ~109  
**Impact**: Wasted network request + no preload benefit

```html
<link rel="preload" href="/_next/static/media/inter-latin-400.woff2" ... />
```

Actual font filenames are hashed (e.g., `be2afef9721bdbc2-s.woff2`). This preload link targets a non-existent file — the browser silently fails, providing zero benefit while wasting a connection slot.

**Fix**: Remove the hardcoded preload. `next/font` already handles font preloading automatically via its built-in `<link rel="preload">` injection.

### C2. Noto Sans SC with `preload: true` — 108 Font Files, 4.7 MB
**File**: `app/layout.tsx` lines 28-35  
**Impact**: Forces download of CJK font subsets for ALL visitors

```typescript
const notoSansSC = Noto_Sans_SC({
  preload: true,  // 🔴 Forces CJK subsets into preload
  subsets: ["latin"],
  weight: ["400", "700"],
})
```

Even with `subsets: ["latin"]`, Google Fonts for CJK fonts generates ~100+ unicode-range subsets. With `preload: true`, the browser eagerly fetches these during initial load. Most users viewing an English-primary page don't need CJK glyphs for LCP.

**Fix**: Set `preload: false`. The font will still load on demand when CJK characters are encountered, but won't block LCP.

### C3. `Box` Component is `'use client'`
**File**: `app/components/base/Box.tsx`  
**Impact**: Creates client component boundary everywhere it's used

`Box` is a thin wrapper over `<div>` that maps design tokens to inline styles. It's marked `'use client'` and imported in Server Components like `HomePage.tsx`. While Next.js handles this correctly (client island within server tree), every `Box` instance requires hydration.

**Fix**: (Phase 2) Create a `ServerBox` component without `'use client'` for static usage, or convert `Box` to a shared component that works in both contexts. For now, this is a moderate concern — the actual performance impact depends on how many Box instances exist in the LCP critical path.

### C4. `React.lazy()` in Server Component
**File**: `app/components/home/HomePage.tsx` line 20

```typescript
const SidebarSection = lazy(() => import('./SidebarSection'))
```

While `React.lazy()` technically works in Server Components for client component boundaries, `next/dynamic` is the idiomatic Next.js approach and provides better features (loading states, `ssr` control).

**Fix**: Replace with `next/dynamic`.

---

## 🟡 Moderate Issues

### M1. Large Client Bundle (1.9 MB uncompressed)
Top chunks loaded on every page:
| Chunk | Size | Content |
|-------|------|---------|
| `3288-*.js` | 619 KB | Next.js App Router runtime |
| `main-*.js` | 559 KB | Next.js main runtime |
| `4bd1b696-*.js` | 194 KB | Shared vendor chunk |
| `6228-*.js` | 191 KB | Supabase client |
| `framework-*.js` | 185 KB | React 19 |
| `52774a7f-*.js` | 115 KB | Sentry SDK |
| `polyfills-*.js` | 110 KB | Polyfills |

The App Router runtime (619KB) and main.js (559KB) are structural — not much can be done. But Sentry (115KB) and Polyfills (110KB) could potentially be lazy-loaded.

### M2. All Home Components are Client Components
Every component in `app/components/home/` is `'use client'`:
- `HomePageClient.tsx` — required (uses hooks)
- `RankingSection.tsx` — required (interactive)
- `StatsBar.tsx` — ⚠️ Could be partially server-rendered
- `SidebarSection.tsx` — ⚠️ Already lazy-loaded, but still client
- `MarketPanel.tsx` — ⚠️ Uses Supabase realtime
- `TimeRangeSelector.tsx` — required (interactive)

`StatsBar` renders exchange stats that could be server-fetched and streamed.

### M3. Deep Client Provider Nesting
```
<body>
  <Providers>          ← 'use client' (SWR, Language, Premium, Toast, Dialog)
    <CapacitorProvider> ← 'use client' (native app init)
      <AsyncStylesheets />
      <WebVitals />     ← 'use client'
      <SpeedInsights />
      ...
      {children}
    </CapacitorProvider>
  </Providers>
</body>
```

All children of `<Providers>` are within a client boundary. While Server Components passed as `{children}` still render on the server (props serialization), this pattern means every provider mounts and hydrates on every page load.

### M4. TopNav — 800+ Lines, Fully Client
`TopNav` is a large client component importing stores (`inboxStore`, `postStore`), Supabase client, and multiple lazy-loaded panels. It's in the critical render path (above the fold).

**Recommendation** (Phase 2): Extract static parts (logo, nav links) into a Server Component shell, with client interactivity (search, notifications, account) as islands.

---

## 📊 Build Output Analysis

```
Build: Next.js 16.1.6 (webpack), compiled in 10.7s
Static pages: 81/81 generated in 1202ms (7 workers)
Homepage: ○ / (Static, ISR 30s)
```

- Homepage is correctly ISR-cached (○ marker)
- Static generation is fast (1.2s for 81 pages)
- No build warnings or errors

---

## 🔧 Fixes Applied (Phase 1)

### Fix 1: Remove broken font preload link
- **File**: `app/layout.tsx`
- Removed hardcoded `<link rel="preload" href="/_next/static/media/inter-latin-400.woff2">`
- `next/font` already handles preloading with correct hashed filenames

### Fix 2: Defer Noto Sans SC preloading
- **File**: `app/layout.tsx`
- Changed `preload: true` → `preload: false` for Noto Sans SC
- CJK font subsets will load on demand instead of blocking LCP
- Added comment explaining the rationale

### Fix 3: Replace `React.lazy` with `next/dynamic`
- **File**: `app/components/home/HomePage.tsx`
- Replaced `lazy(() => import('./SidebarSection'))` with `dynamic(() => import('./SidebarSection'), { ssr: false })`
- SidebarSection is non-critical sidebar content — `ssr: false` skips server render for faster TTFB

---

## 📋 Phase 2 Recommendations (Future)

| Priority | Item | Est. Impact | Effort |
|----------|------|-------------|--------|
| High | Lazy-load Sentry SDK (115KB) via `next/dynamic` | -35KB gzip | Medium |
| High | Server Component TopNav shell | -20KB gzip | High |
| Medium | Convert `StatsBar` to Server Component with streaming | -5KB gzip | Medium |
| Medium | Conditional polyfills (modern browsers skip) | -35KB gzip | Medium |
| Low | ServerBox component for static usage | Reduced hydration | Low |
| Low | Evaluate Turbopack for smaller runtime | Unknown | Low |

---

## 🔗 Key File References

| File | Role | Type |
|------|------|------|
| `app/page.tsx` | Homepage entry, ISR config | Server Component |
| `app/layout.tsx` | Root layout, fonts, providers | Server Component (wraps client) |
| `app/components/home/HomePage.tsx` | Page shell, 3-column grid | Server Component |
| `app/components/home/HomePageClient.tsx` | Interactive ranking section | Client Component |
| `app/components/home/RankingTableSkeleton.tsx` | LCP fallback skeleton | Server Component |
| `lib/performance/critical-css.ts` | Inlined critical CSS | Server utility |
| `app/components/Providers/AsyncStylesheets.tsx` | Deferred CSS loader | Client Component |
| `next.config.ts` | Build config, Sentry wrapper | Config |
| `instrumentation.ts` | Server-only Sentry init | Server |
