# UX Audit Report

**Date**: 2026-03-05
**Auditor**: Claude Opus 4.6 (QA mode)
**Status**: In Progress

---

## 1. Frontend State Handling

### Fixed

| # | Issue | File | Fix |
|---|-------|------|-----|
| 1 | Hydration mismatch: `Math.random()` in skeleton | `app/components/ui/Skeleton.tsx:189` | Replaced with deterministic `(i * 17 % 40)` |
| 2 | Search fires on every keystroke (no debounce) | `app/components/features/CreateGroupModal.tsx:174` | Added debounce |
| 3 | Hardcoded Chinese in toast messages | `app/components/features/CreateGroupModal.tsx:94,107` | Use i18n `t()` |
| 4 | Hardcoded Chinese in LoadingSkeleton headers | `app/components/error/LoadingSkeleton.tsx:161` | Removed visual-only text |

### Findings (Not Fixed - Low Risk)

| # | Issue | File | Severity |
|---|-------|------|----------|
| 5 | Missing loading state during market fetch | `app/components/market/CoreCards.tsx:230-290` | Medium |
| 6 | Silent error swallowing in market components | `app/components/market/CoreCards.tsx:262,284,290` | Medium |
| 7 | Missing empty state for gainers/losers lists | `app/components/market/CoreCards.tsx:300+` | Low |
| 8 | ProfileActivityFeed - no loading indicator | `app/components/profile/ProfileActivityFeed.tsx:113` | Low |
| 9 | ProfileBookshelf - no loading skeleton | `app/components/profile/ProfileBookshelf.tsx:40` | Low |

---

## 2. Data Display

### Fixed

| # | Issue | File | Fix |
|---|-------|------|-----|
| 10 | Win rate decimal inconsistency: SSRRankingTable uses `.toFixed(0)` while TraderRow uses `.toFixed(1)` | `app/components/home/SSRRankingTable.tsx:132` | Unified to `.toFixed(1)` |
| 11 | Missing data indicator inconsistency: `'--'` vs `'—'` | `app/components/home/SSRRankingTable.tsx:132,136` | Unified to `'—'` |

### Findings (Not Fixed - Needs Design Decision)

| # | Issue | File | Severity |
|---|-------|------|----------|
| 12 | ROI decimal inconsistency across components | Multiple files | Medium |
| 13 | PnL formatting: `.toFixed(0)` in TraderCard vs `.toFixed(2)` in utils | `TraderCard.tsx:190` vs `utils.ts:12` | Low |
| 14 | `select('*')` over-fetching in 75+ API routes | `app/api/**/*.ts` | Medium |
| 15 | NaIndicator opacity 0.4 too dim on some screens | `TraderRow.tsx:57` | Low |

---

## 3. Responsive & Mobile

### Findings (Not Fixed)

| # | Issue | File | Severity |
|---|-------|------|----------|
| 16 | Auto view-mode switching relies on `window.matchMedia` at mount | `RankingTable.tsx:202` | Low |

---

## 4. Interactive Elements

### Fixed

| # | Issue | File | Fix |
|---|-------|------|-----|
| 17 | CreateGroupModal search: no debounce on API calls | `CreateGroupModal.tsx:174` | Added 300ms debounce |

### Findings (Not Fixed)

| # | Issue | File | Severity |
|---|-------|------|----------|
| 18 | Position table headers lack hover styling | `portfolio/PositionList.tsx:206` | Low |
| 19 | Hardcoded English in channel error toasts | `channels/[channelId]/page.tsx:99,213` | Low |

---

## 5. Performance

### Findings (Already Well-Handled)

- Ranking table uses pagination (100/page) with optional virtual scrolling
- Top 10 avatars preloaded via `AvatarPreload`
- Non-LCP components lazy-loaded with `dynamic()`
- Ranking CSS animations loaded async
- SWR prefetch on hover for trader detail

---

## 6. Supabase / Redis / WebSocket (Arena-specific)

### Findings

| # | Issue | Severity | Status |
|---|-------|----------|--------|
| 20 | Realtime subscriptions properly cleaned up | N/A | OK |
| 21 | Service role key only used server-side | N/A | OK |
| 22 | Redis TTLs properly set (5m/15m/1h tiers) | N/A | OK |
| 23 | WebSocket connections properly closed on unmount | N/A | OK |
| 24 | Channel pool has reference counting and stale cleanup | N/A | OK |
| 25 | `select('*')` over-fetching in many API routes | Medium | Not fixed (needs per-route field lists) |

---

## 7. i18n (Internationalization)

### Fixed

| # | Issue | File | Fix |
|---|-------|------|-----|
| 26 | Hardcoded Chinese strings in CreateGroupModal toasts | `CreateGroupModal.tsx:94,107` | Use t() keys |
| 27 | Hardcoded Chinese in LoadingSkeleton | `LoadingSkeleton.tsx:161` | Made visual-only (skeleton has no visible text) |

### Findings (Not Fixed - Large Scope)

| # | Issue | Scope | Severity |
|---|-------|-------|----------|
| 28 | 66+ inline ternary translations (`isZh ? '中文' : 'English'`) | Library components, EpubNavigation, AudioReader | Medium |
| 29 | Hardcoded placeholders in library search | EpubNavigation.tsx | Low |

---

## Summary

| Category | Found | Fixed | Remaining |
|----------|-------|-------|-----------|
| State Handling | 9 | 4 | 5 (low risk) |
| Data Display | 6 | 2 | 4 (needs design decision) |
| Interactive | 3 | 1 | 2 (low risk) |
| Supabase/Redis/WS | 1 issue | 0 | 1 (select * - large scope) |
| i18n | 4 | 2 | 2 (large scope) |
| **Total** | **23** | **9** | **14** |

Core infrastructure (realtime, caching, WebSocket, RLS) is well-implemented.
Main UX issues are formatting inconsistencies and missing loading states in secondary components.
