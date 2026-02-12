# Performance Audit R5 — 2026-02-12

## Summary

Overall the codebase is **well-optimized**. Key patterns already in place:
- `next/font` with selective weight loading
- `next/image` everywhere (zero raw `<img>` tags)
- `lazy()` / `dynamic()` for below-fold components
- Cache-Control headers on key API routes
- Critical CSS inlining + async stylesheet loading
- `optimizePackageImports` for large packages
- DNS prefetch + resource hints

---

## 1. Build & Bundle Size

**Build**: Turbopack (Next.js 16.1.6) — builds successfully after fixing deprecated `ppr: 'incremental'` config.

**Note**: Turbopack doesn't output per-route bundle sizes like Webpack. Use `npm run analyze` (Webpack mode) for detailed bundle analysis.

---

## 2. Images ✅

- **Zero raw `<img>` tags** — all images use `next/image` `<Image>` component
- **41 files** import `next/image`
- Most images use `loading="lazy"` for below-fold content
- LCP images correctly use `priority`

**No action needed.**

---

## 3. API Caching

### Well-cached routes (27+ routes with Cache-Control):
- `/api/traders/[handle]` — `s-maxage=60, stale-while-revalidate=300`
- `/api/sidebar/*` — `s-maxage=180-300`
- `/api/bots/*` — `s-maxage=120`
- `/api/posts/link-preview` — `s-maxage=3600` (good for static content)
- `/api/health/*` — `no-store` (correct)

### Routes without explicit caching (211 routes):
Most are mutation endpoints (POST/PUT/DELETE) or auth-gated routes where `no-cache` is appropriate by default. However, some **read-only public endpoints** could benefit from caching:

**Recommendations (medium effort):**
- `/api/avoid-list` — add `s-maxage=300` (static-ish data)
- `/api/saved-filters` — add `private, max-age=60` (user-specific but stable)
- `/api/calls/signal` — evaluate if cacheable

---

## 4. React Re-renders

### Stats
- **229 files** use `useEffect`
- **149 files** use `useMemo`/`useCallback`/`React.memo`

### Large components (potential re-render issues):

| File | Lines | Concern |
|------|-------|---------|
| `messages/[conversationId]/page.tsx` | 2197 | 30+ useState hooks — consider splitting into sub-components |
| `groups/[id]/manage/page.tsx` | 2062 | 128 inline styles, many state vars |
| `components/post/PostFeed.tsx` | 1812 | Complex, but already uses useCallback |
| `hot/page.tsx` | 1484 | Already uses useMemo/useCallback/lazy — well optimized |
| `u/[handle]/UserProfileClient.tsx` | 909 | Many state vars, but manageable |

**Recommendations (large effort — do not fix now):**
- **Split `messages/[conversationId]/page.tsx`** into MessageList, MessageInput, ConversationHeader sub-components
- **Split `groups/[id]/manage/page.tsx`** into tab-based sub-components
- These are the biggest re-render risk areas

---

## 5. Inline Styles

Heavy inline style usage throughout — this is a design-token-based architecture, so most `style={{}}` usage is intentional and acceptable.

| File | `style={{}}` count |
|------|-------------------|
| `groups/[id]/manage/page.tsx` | 128 |
| `messages/[conversationId]/page.tsx` | 99 |
| `groups/[id]/ui/GroupPostList.tsx` | 93 |
| `groups/apply/page.tsx` | 91 |

**Not a performance issue** — React inline styles don't cause layout thrashing. The design-token approach is preferable to extracting into CSS modules for this project's architecture.

---

## 6. Third-Party Scripts ✅

- **No render-blocking third-party scripts** in `<head>`
- All third-party components are loaded via `dynamic()`:
  - `SpeedInsights`, `Analytics` (Vercel)
  - `WebVitals`
  - `ServiceWorkerRegistration`
- `JsonLd` uses `next/script` (non-blocking)
- Stripe/Cloudflare loaded via CSP, not inline `<script>` tags

**No action needed.**

---

## 7. Fetch Waterfalls

### `hot/page.tsx` — minor waterfall
Lines 131-175: Two sequential Supabase queries (trader_snapshots → trader_sources) where the second depends on results of the first. **This is unavoidable** since the second query needs IDs from the first.

### `trader/[handle]/layout.tsx` ✅
Already uses `Promise.all` for parallel metadata fetching.

### Global: 72 uses of `Promise.all` across the codebase — good parallel fetch patterns.

---

## Fixes Applied

### 1. Fixed deprecated `ppr: 'incremental'` in `next.config.ts`
- Next.js 16 merged PPR into `cacheComponents`
- Commented out the deprecated config to allow builds to succeed

### 2. Fixed TypeScript syntax error in `UserProfileClient.tsx`
- Missing IIFE closing `)}()}`  for the cover photo pattern
- Pre-existing bug from uncommitted changes

---

## Recommendations (Future — Large Effort)

1. **Run webpack bundle analysis**: `npm run analyze` to get per-route sizes and identify large dependencies
2. **Split mega-components**: messages page (2197 lines) and group manage page (2062 lines) into sub-components
3. **Add cache headers to read-only API routes**: ~211 routes lack explicit caching; most are mutations but some reads could benefit
4. **Consider React Compiler**: Next.js 16 supports it — would auto-memoize and eliminate manual `useMemo`/`useCallback`
5. **Evaluate `force-dynamic` on `trader/[handle]/layout.tsx`**: Could use ISR with `revalidate` instead for better performance (currently disabled due to Upstash Redis issues at build time)
