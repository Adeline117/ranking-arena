# Arena Architecture Decision Records (ADR)

> Document key technical decisions. Format: Context → Decision → Consequences

---

## ADR-001: Supabase as Primary Database
**Date:** 2024-01
**Status:** Accepted

### Context
Need managed PostgreSQL with auth, realtime, and RLS for a social trading platform.

### Decision
Use Supabase (PostgreSQL + Auth + Realtime + Storage).

### Consequences
- ✅ Built-in auth with social providers
- ✅ Row-level security for multi-tenant data
- ✅ Realtime subscriptions for live updates
- ⚠️ Vendor lock-in for auth layer
- ⚠️ Must manage RLS policies carefully

---

## ADR-002: Composite Key for Trader Identity
**Date:** 2024-01
**Status:** Accepted

### Context
Traders exist on multiple platforms with different IDs.

### Decision
Use `(source, source_trader_id)` as composite unique key in `trader_sources`.

### Consequences
- ✅ Same trader on different platforms tracked separately
- ✅ Easy to query by platform
- ⚠️ Cross-platform trader deduplication requires separate logic

---

## ADR-003: Vercel Cron for Data Pipeline
**Date:** 2024-02
**Status:** Accepted

### Context
Need scheduled jobs to fetch and process trader data from 27+ exchanges.

### Decision
Use Vercel Cron (serverless) with batch groups (a-f) for rate limit management.

### Consequences
- ✅ Zero infrastructure management
- ✅ Auto-scaling for burst loads
- ⚠️ 10-second timeout for hobby, 60s for pro
- ⚠️ Must batch large operations

---

## ADR-004: Cloudflare Worker for Geo-Blocked APIs
**Date:** 2024-02
**Status:** Accepted

### Context
Binance/OKX APIs geo-blocked in some regions. Vercel (hnd1) sometimes blocked.

### Decision
Deploy Cloudflare Worker as proxy fallback. Connector auto-switches on failure.

### Consequences
- ✅ Reliable data fetching regardless of region
- ✅ Transparent fallback in connector layer
- ⚠️ Additional latency (~50-100ms)
- ⚠️ Must maintain CF worker code

---

## ADR-005: Arena Score Formula
**Date:** 2024-01
**Status:** Accepted

### Context
Need unified ranking across platforms with different metrics.

### Decision
```
Arena Score = (ROI_percentile × 0.6) + (PnL_percentile × 0.4)
```

### Consequences
- ✅ Balances return rate with absolute profit
- ✅ Percentile-based = fair across platforms
- ⚠️ May favor high-capital traders slightly
- ⚠️ Requires periodic recalibration

---

## ADR-006: Server Components by Default
**Date:** 2024-02
**Status:** Accepted

### Context
Next.js 16 App Router supports RSC. Need to decide default rendering strategy.

### Decision
Server Components default. Use `'use client'` only for interactive components.

### Consequences
- ✅ Smaller client bundle
- ✅ Direct database access in components
- ⚠️ Must be careful with client state
- ⚠️ Hydration errors if not careful

---

## ADR-007: Upstash Redis for Caching
**Date:** 2024-01
**Status:** Accepted

### Context
Need caching layer for frequently accessed data (rankings, market data).

### Decision
Use Upstash Redis (serverless, HTTP-based).

### Consequences
- ✅ Works in Edge runtime
- ✅ Pay-per-request pricing
- ⚠️ Slightly higher latency than TCP Redis
- ⚠️ Must handle cache invalidation carefully

---

## ADR-008: i18n with Simple Object Maps
**Date:** 2024-01
**Status:** Accepted

### Context
Need Chinese (primary) and English support.

### Decision
Simple `lib/i18n.ts` with language object maps. No heavy i18n library.

### Consequences
- ✅ Zero runtime overhead
- ✅ Type-safe translations
- ⚠️ Manual key management
- ⚠️ No pluralization rules (not needed for zh/en)

---

## ADR-009: Stripe for Payments
**Date:** 2024-02
**Status:** Accepted

### Context
Need subscription management for Pro membership.

### Decision
Stripe Checkout + Webhooks for subscription lifecycle.

### Consequences
- ✅ Industry-standard security
- ✅ Handles tax/invoicing
- ⚠️ Processing fees
- ⚠️ Must sync webhook events to DB

---

## ADR-010: VPS for Long-Running Scrapes
**Date:** 2024-03
**Status:** Accepted

### Context
Some exchange scraping requires browser automation (Puppeteer) exceeding serverless limits.

### Decision
Deploy cron scripts to US-based VPS for geo-unblocked, long-running tasks.

### Consequences
- ✅ No timeout limits
- ✅ US IP for geo-blocked APIs
- ⚠️ Manual deployment/monitoring
- ⚠️ Additional infrastructure cost

---

## Pending Decisions

### Should we add WebSocket for real-time rankings?
**Context:** Users want live updates without refresh.
**Options:**
1. Supabase Realtime subscriptions
2. Custom WebSocket server
3. Polling with SWR/React Query

**Status:** Under consideration

---

## Decision Template
```markdown
## ADR-XXX: [Title]
**Date:** YYYY-MM
**Status:** Proposed | Accepted | Deprecated | Superseded

### Context
[Why is this decision needed?]

### Decision
[What was decided?]

### Consequences
- ✅ Positive outcome
- ⚠️ Trade-off or risk
```
