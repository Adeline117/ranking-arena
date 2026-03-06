# Comprehensive Codebase Audit Report

Generated: 2026-03-05

## Executive Summary

| Category | Findings | Critical | High | Medium | Low |
|----------|----------|----------|------|--------|-----|
| 1. Over-complex code | 15 god files | 0 | 5 | 7 | 3 |
| 2. Dependencies | 0 unused (cleaned) | 0 | 0 | 0 | 0 |
| 3. Environment vars | 27 files fixed | 0 | 0 | 0 | 0 |
| 4. API routes | 295 total routes | 2 | 5 | 8 | - |
| 5. Styles | 6,497 inline styles | 0 | 3 | 5 | - |
| 6. Data fetching | N+1 patterns found | 0 | 3 | 4 | - |
| 7. Error handling | 15+ silent catches | 0 | 5 | 10 | - |
| 8. Naming conventions | Mixed patterns | 0 | 0 | 5 | 5 |
| 9. Security | Creds removed | 1 | 3 | 5 | - |

---

## 1. Over-Complex Code

### God Files (500+ lines)
These files are too large and should be split:

| File | Lines | Issue |
|------|-------|-------|
| `lib/i18n/zh.ts` | 3,642 | Translation file - OK for i18n |
| `lib/i18n/en.ts` | 3,635 | Translation file - OK for i18n |
| `lib/cron/fetchers/enrichment.ts` | 1,636 | **HIGH** - Should split by exchange |
| `app/u/[handle]/new/page.tsx` | 1,622 | **HIGH** - Monolithic page component |
| `app/hot/page.tsx` | 1,504 | **HIGH** - Should extract sub-components |
| `app/library/[id]/read/page.tsx` | 1,363 | **HIGH** - Reader page, complex but fixable |
| `app/groups/[id]/new/page.tsx` | 1,262 | **HIGH** - Group creation wizard |
| `app/api/traders/[handle]/route.ts` | 1,162 | **MEDIUM** - Large API route |
| `app/settings/page.tsx` | 1,104 | **MEDIUM** - Settings page |
| `app/groups/apply/page.tsx` | 1,086 | **MEDIUM** - Application form |
| `lib/data/trader.ts` | 1,037 | **MEDIUM** - Data layer, many functions |
| `app/pk/[trader_a]/[trader_b]/page.tsx` | 1,037 | **MEDIUM** - Comparison page |
| `app/components/ui/PageSkeleton.tsx` | 961 | **MEDIUM** - 165 inline styles! |
| `app/groups/[id]/ui/GroupPostList.tsx` | 960 | **MEDIUM** - Post list component |
| `app/u/[handle]/UserProfileClient.tsx` | 957 | **MEDIUM** - Profile client |

### Recommendations
- `enrichment.ts` (1,636 lines): Split into per-exchange enrichment modules
- Page components >1000 lines: Extract form sections, data fetching, and sub-components
- `PageSkeleton.tsx`: 165 inline styles - convert to Tailwind classes

---

## 2. Dependencies (COMPLETED)

**Status: Fixed in previous session**
- Removed 20 unused packages (14 @capacitor/*, node-fetch, fast-xml-parser, etc.)
- `npm audit fix` resolved 8 vulnerabilities
- Restored `@mathieuc/tradingview` (used via `require()`)

---

## 3. Environment Variables (COMPLETED)

**Status: Fixed this session**
- Removed hardcoded DB passwords from 27 active files
- Removed hardcoded VPS passwords
- Removed hardcoded PostgreSQL connection strings
- Archive files (`scripts/_archive/`) left as-is (dead code)
- **ACTION NEEDED**: Rotate Supabase service_role key in dashboard (exposed in git history)

---

## 4. API Routes Audit

### Overview
- **Total routes**: 295 (237 app + 47 cron + 11 other)
- **With rate limiting**: 126 routes (43%)
- **Using getSupabaseAdmin()**: 76+ occurrences (bypasses RLS)

### Missing Rate Limiting (HIGH)
169 routes lack rate limiting. Priority routes to add:

| Route | Risk | Reason |
|-------|------|--------|
| `api/posts/[id]/like` | HIGH | Can be spammed |
| `api/posts/[id]/bookmark` | HIGH | Can be spammed |
| `api/posts/[id]/vote` | HIGH | Can be spammed |
| `api/users/follow` | HIGH | Follow/unfollow spam |
| `api/posts/[id]/comments/like` | HIGH | Can be spammed |

### Response Format Inconsistency
Most routes return `{ data: ... }` or `{ error: ... }` but some return bare objects. Should standardize to:
```typescript
// Success: { data: T }
// Error: { error: string, code?: string }
```

### Auth Check Gaps
Routes that handle user data but may have inconsistent auth:
- Several cron routes use `CRON_SECRET` check (correct)
- All user-facing routes should use `requireAuth()` or `getAuthUser()`

---

## 5. Styles Audit

### Inline Styles
- **6,497 `style={{}}` occurrences** across 368 files
- Worst offenders:
  - `PageSkeleton.tsx`: 165 inline styles
  - `GroupPostList.tsx`: 91
  - `MembershipContent.tsx`: 87
  - `PortfolioTable.tsx`: 83
  - `hot/page.tsx`: 80
  - `groups/[id]/new/page.tsx`: 74
  - `library/[id]/read/page.tsx`: 69
  - `search/page.tsx`: 61
  - `UserProfileClient.tsx`: 60
  - `SecuritySection.tsx`: 59

### Z-Index Management
- **172 z-index values** across 107 files
- No centralized z-index scale
- Values range from z-[1] to z-[9999]
- Key overlap areas:
  - Modals, dropdowns, overlays compete for z-index space
  - `library/[id]/read/page.tsx` has 11 z-index values alone

### Recommendation
- Create `lib/design-tokens.ts` z-index scale (already referenced in CLAUDE.md)
- Migrate top-20 inline-style-heavy files to Tailwind

---

## 6. Data Fetching Audit

### N+1 Query Patterns (HIGH)
Found in `app/api/traders/[handle]/route.ts` - fetches trader, then separate queries for:
- Reviews
- Performance data
- Similar traders
- User follow status

These should be batched or use SQL joins.

### React Query Configuration
- Most hooks properly configure `staleTime`
- Some missing `gcTime` (garbage collection time)

### Client vs Server Components
- Most data-heavy pages use server components (good)
- Some client components re-fetch data that's available from server

---

## 7. Error Handling Audit

### Silent Catch Blocks (15+ occurrences)
Files with `catch { /* ignore */ }` or similar:

| File | Count | Risk |
|------|-------|------|
| `channels/[channelId]/page.tsx` | 4 | MEDIUM - channel operations silently fail |
| `notifications/page.tsx` | 1 | LOW |
| `flash-news/page.tsx` | 1 | LOW |
| `logout/page.tsx` | 2 | LOW - localStorage cleanup |
| `u/[handle]/page.tsx` | 1 | LOW |
| `market/SentimentBar.tsx` | 1 | LOW |
| `market/TokenSidePanel.tsx` | 1 | LOW |
| `market/SpotMarket.tsx` | 1 | LOW |
| `market/ArbitrageOpportunities.tsx` | 1 | MEDIUM |
| `inbox/ConversationsList.tsx` | 1 | MEDIUM |
| `alerts/AlertConfig.tsx` | 1 | MEDIUM |

### `console.log` Usage
ESLint rule `no-console` is set to "warn" - good. No `console.log` found in app/ (all cleaned or using `logger`).

### Catch Blocks in API Routes
- 37 catch blocks in app/ API routes
- Most properly return error responses
- Some catch blocks need more specific error status codes

---

## 8. Naming Conventions Audit

### File Naming
- **Components**: PascalCase (correct) - `TraderHeader.tsx`, `RankingTable.tsx`
- **Pages**: lowercase (correct for Next.js) - `page.tsx`
- **Utilities**: camelCase (correct) - `formatNumber.ts`
- **API routes**: kebab-case directories (correct) - `api/flash-news/`
- **Hooks**: `use` prefix (correct) - `useAuthSession.ts`

### Mixed Language
- Code comments mix Chinese and English (by design - bilingual team)
- Variable names are consistently English (good)
- Error messages use i18n system (good)

### Minor Issues
- Some TypeScript interfaces use `I` prefix, others don't - inconsistent
- Some files in `lib/` use kebab-case, others use camelCase
  - `lib/design-tokens.ts` vs `lib/formatters.ts` - both kebab
  - `lib/i18n.ts` vs `lib/i18n/` directory - OK

### Verdict: Generally consistent, minor issues only

---

## 9. Security Audit

### CRITICAL: Credential Rotation Needed
- Hardcoded Supabase service_role key exists in git history
- **ACTION**: Rotate key in Supabase dashboard immediately

### HIGH: Rate Limiting Gaps
- 57% of API routes lack rate limiting
- User-action routes (like, follow, bookmark) are most vulnerable

### HIGH: getSupabaseAdmin() Overuse
- 76+ occurrences across API routes
- This bypasses RLS policies
- Some routes could use user-scoped clients instead

### MEDIUM: Input Validation
- Query parameters often used directly without validation
- Body parsing relies on TypeScript types (no runtime validation)
- Consider Zod schemas for critical routes

### MEDIUM: CORS
- No explicit CORS headers in most routes
- Relying on Next.js defaults (same-origin)
- External API consumers may need CORS headers

### LOW: CSP Headers
- No Content-Security-Policy headers configured
- Would help prevent XSS

---

## Priority Action Items

### Immediate (P0)
1. **Rotate Supabase service_role key** in dashboard
2. Add rate limiting to user-action routes (like, follow, bookmark, vote)

### Soon (P1)
3. Split `enrichment.ts` (1,636 lines) into per-exchange modules
4. Add Zod validation to critical API routes (payments, auth)
5. Create centralized z-index scale in design tokens

### Later (P2)
6. Migrate top-20 inline-style files to Tailwind
7. Split page components >1000 lines
8. Add runtime input validation for all API routes
9. Standardize API response format across all routes
10. Review getSupabaseAdmin() usage - switch to user-scoped where possible
