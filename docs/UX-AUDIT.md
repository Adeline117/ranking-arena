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

### Verified OK (False Positives)

| # | Issue | Actual Status |
|---|-------|---------------|
| 5-7 | CoreCards loading/error/empty states | Already has skeleton loading + `t('noGainers')`/`t('noLosers')` empty states + spot fallback |
| 8 | ProfileActivityFeed loading | Already has skeleton loading state (line 120-129) |
| 9 | ProfileBookshelf loading | Already has skeleton loading state (line 54+) |

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

### Fixed

| # | Issue | File | Fix |
|---|-------|------|-----|
| 19 | Hardcoded English in channel error toasts | `channels/[channelId]/page.tsx:89,99,187,211,213` | Use `t('loadFailed2')`, `t('sendFailed')`, `t('uploadFailed')` |

### Findings (Not Fixed)

| # | Issue | File | Severity |
|---|-------|------|----------|
| 18 | Position table headers lack hover styling | `portfolio/PositionList.tsx:206` | Low |

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

| Category | Found | Fixed | False Positive | Remaining |
|----------|-------|-------|----------------|-----------|
| State Handling | 9 | 4 | 5 (already handled) | 0 |
| Data Display | 6 | 2 | 0 | 4 (needs design decision) |
| Interactive | 3 | 2 | 0 | 1 (low risk) |
| Supabase/Redis/WS | 1 issue | 0 | 0 | 1 (select * - large scope) |
| i18n | 4 | 3 | 0 | 1 (large scope - ternary pattern) |
| **Total** | **23** | **11** | **5** | **7** |

Core infrastructure (realtime, caching, WebSocket, RLS) is well-implemented.
Remaining items are design decisions (ROI/PnL formatting), low-risk cosmetics, or large-scope refactors (ternary i18n pattern, select(*)).
