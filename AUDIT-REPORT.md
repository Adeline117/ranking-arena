# Comprehensive Codebase Audit Report

Generated: 2026-03-05 (Updated with agent findings)

## Executive Summary

| Category | Findings | Critical | High | Medium | Low |
|----------|----------|----------|------|--------|-----|
| 1. Over-complex code | 15 god files, 40+ dup fetchers | 0 | 6 | 7 | 3 |
| 2. Dependencies | 4 unused remain | 0 | 2 | 2 | 0 |
| 3. Environment vars | 27 files fixed + .env issues | 1 | 3 | 2 | 0 |
| 4. API routes | 295 total, 2 critical auth gaps | 2 | 3 | 5 | 3 |
| 5. Styles | 6,497 inline styles | 0 | 3 | 5 | - |
| 6. Data fetching | N+1, missing AbortController | 0 | 3 | 4 | - |
| 7. Error handling | 26+ silent catches | 0 | 5 | 10 | 5 |
| 8. Naming conventions | Minor abbreviation issues | 0 | 0 | 2 | 3 |
| 9. Security | Creds removed, cron auth gap | 2 | 3 | 5 | - |

---

## 1. Over-Complex Code

### God Files (500+ lines)
| File | Lines | Severity | Issue |
|------|-------|----------|-------|
| `lib/cron/fetchers/enrichment.ts` | 1,636 | **HIGH** | 8+ exchange fetchers + equity curve + position history |
| `app/u/[handle]/new/page.tsx` | 1,622 | **HIGH** | Monolithic page |
| `app/hot/page.tsx` | 1,504 | **HIGH** | Should extract sub-components |
| `app/library/[id]/read/page.tsx` | 1,363 | **HIGH** | Reader page |
| `app/groups/[id]/new/page.tsx` | 1,262 | **HIGH** | Group creation wizard |
| `app/api/traders/[handle]/route.ts` | 1,162 | MEDIUM | Large API route |
| `app/api/stripe/webhook/route.ts` | 802 | **HIGH** | 8 concerns in one handler |

### Functions Over 100 Lines
| File | Function | Lines |
|------|----------|-------|
| `app/api/cron/enrich/route.ts` | `handleEnrichment()` | ~220 |
| `lib/cron/fetchers/binance-futures.ts` | `fetchPeriod()` | ~170 |
| `lib/cron/fetchers/bybit.ts` | `fetchPeriod()` | ~160 |
| `app/api/stripe/webhook/route.ts` | `POST()` | ~142 |

### Deep Nesting (4+ levels)
- `lib/utils/arena-score.ts:calculateOverallScore()` - 7 if-else branches, should use lookup table
- `app/api/stripe/webhook/route.ts:handleCheckoutComplete()` - 3 internal try-catch blocks
- `lib/cron/fetchers/enrichment.ts:fetchBinanceStatsDetail()` - loop + nested ifs

### Magic Numbers
| File | Number | Context |
|------|--------|---------|
| `lib/cron/fetchers/shared.ts:64-67` | `0.08, 1.8, 15, 62` | Arena score tanh coefficients |
| `lib/cron/fetchers/shared.ts:70-74` | `500, 2000, 5000` | PnL score bases |
| `lib/cron/fetchers/enrichment.ts:923` | `720` | 30 days in hours |
| `lib/scoring/anomaly-detection.ts:28-30` | `50000, -99` | ROI thresholds |

### Duplicate Logic (40+ fetchers)
Position stats calculation duplicated 3x in enrichment.ts. All 40+ exchange fetchers implement same pagination-transform-enrich-upsert flow independently.

---

## 2. Dependencies

### Remaining Unused
| Package | Status |
|---------|--------|
| `html2canvas` | Never imported - remove |
| `pdfjs-dist` | Never imported - remove |
| `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner` | Only in archive |

---

## 3. Environment Variables

### Completed
- Removed hardcoded DB passwords from 27 active files
- **ACTION NEEDED**: Rotate Supabase service_role key

### .env.local Issues
- Duplicate entries: `CRON_SECRET`, `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` defined twice
- `ENCRYPTION_KEY_PART` vs `ENCRYPTION_KEY_PART1` naming mismatch
- Unused exchange API keys: `GATEIO_API_KEY`, `DRIFT_API_KEY`, `OKX_API_KEY`

---

## 4. API Routes Audit

### CRITICAL: CRON_SECRET Auth Bypass
```typescript
// DANGEROUS: if CRON_SECRET undefined, ANY request bypasses auth
if (cronSecret && authHeader !== `Bearer ${cronSecret}`) { return 401 }
// FIX: if (!cronSecret || authHeader !== `Bearer ${cronSecret}`)
```
Affected: `batch-fetch-traders/route.ts`, `health/pipeline/route.ts`, potentially others

### HIGH: Duplicate Stripe Webhook Routes
Both `/api/webhook/stripe` and `/api/stripe/webhook` exist - risk of double processing

### Rate Limiting: 275+ routes covered (93%)
Missing: webhook routes, cdn-proxy

### Response Format: Mostly consistent
Uses `success()`, `handleError()` helpers. Some routes return bare `{ error: ... }` instead.

---

## 5. Styles Audit

### Inline Styles: 6,497 across 368 files
Top: PageSkeleton(165), GroupPostList(91), MembershipContent(87), login(50+)

### Z-Index: 172 values, no centralized scale
Range: 0 to 9999 with no consistent layering

---

## 6. Data Fetching

### Issues
- Missing AbortController in `SentimentBar.tsx` useEffect
- N+1 in trader metadata (sequential SELECT instead of JOIN)
- Comments fetched twice in PostFeed.tsx with identical logic
- Fire-and-forget fetches in FloatingActionButton, EpubReader

---

## 7. Error Handling

### 26+ silent `.catch(() => {})` locations
Project has `fireAndForget()` utility but many components don't use it.
HIGH: TokenSidePanel, SpotMarket, BookDetailClient, PostFeed, EpubReader, messages
MEDIUM: FearGreedGauge, SectorPerformance, CoreCards, DefiOverview, HotDiscussions

### 15+ `catch { /* ignore */ }` blocks
Channels page (4), logout (2), market components (4+), inbox (1), alerts (1)

---

## 8. Naming Conventions

Generally good. Issues limited to abbreviated variables in fetcher files:
`d`, `n`, `dd`, `m`, `mv`, `wr`, `ph` should be descriptive names.

---

## 9. Security

### CRITICAL
1. Fix CRON_SECRET auth bypass
2. Rotate Supabase service_role key

### HIGH
3. Resolve duplicate Stripe webhook routes
4. Verify CORS `getCorsOrigin()` implementation

### POSITIVE
- CSRF protection in middleware
- All admin routes verify admin role
- Error messages redacted in 5xx responses
- GDPR-compliant account deletion

---

## Priority Action Items

### P0 (Immediate)
1. Fix CRON_SECRET auth bypass pattern
2. Rotate Supabase service_role key
3. Resolve duplicate Stripe webhook

### P1 (Soon)
4. Replace 26+ `.catch(() => {})` with `fireAndForget()`
5. Split `enrichment.ts` (1,636 lines)
6. Split `stripe/webhook/route.ts` (802 lines)
7. Remove unused deps: `html2canvas`, `pdfjs-dist`
8. Clean duplicate .env.local entries

### P2 (Later)
9. Centralize z-index scale
10. Migrate top-20 inline-style files to Tailwind
11. Extract generic fetcher factory
12. Document Arena Score calibration
13. Add Zod schemas for API inputs
