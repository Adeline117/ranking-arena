# Smart Scheduler Integration Design

## Executive Summary

This document outlines the design for integrating the smart scheduler system into the existing data update infrastructure. The smart scheduler will optimize API call efficiency by adjusting refresh frequencies based on trader activity levels.

**Expected Impact:**
- Reduce API calls by 60-70%
- Maintain data freshness for hot traders (15min)
- Reduce costs by ~$27,690/month
- Improve system scalability

---

## 1. Current System Analysis

### 1.1 Cron Job Schedule (from vercel.json)

| Endpoint | Frequency | Purpose |
|----------|-----------|---------|
| `/api/cron/fetch-followed-traders` | Every hour | Update followed traders |
| `/api/cron/fetch-traders/[platform]` | Every 4 hours | Fetch trader rankings by platform |
| `/api/cron/fetch-details` | Every 2 hours | Fetch detailed trader info |
| `/api/cron/refresh-hot-scores` | Every 5 minutes | Recalculate hot scores |
| `/api/cron/discover-rankings` | Every 4 hours | Discover new traders |

**Current Limitations:**
1. All traders updated at same frequency regardless of activity
2. High API call volume for dormant traders
3. No prioritization based on user interest
4. Fixed intervals don't adapt to trader activity patterns

### 1.2 Data Model Analysis

**Trader Data Tables:**
- `trader_sources` - Trader identity (handle, platform, trader_key)
- `trader_snapshots_v2` - Performance snapshots (7D, 30D, 90D windows)
- `trader_profiles` - Profile information (display_name, avatar, bio)
- `refresh_jobs` - Job queue for background updates

**Key Fields for Activity Classification:**
- `rank` - Current ranking position
- `follower_count` - Number of followers
- `last_seen_at` - Last activity timestamp
- `updated_at` - Last data refresh time

### 1.3 Current Refresh Logic

```typescript
// fetch-details/route.ts - Current approach
const limit = 200  // Fixed limit
const concurrency = 30  // Fixed concurrency
const skipRecent = 6  // Skip if updated in last 6 hours

// No prioritization or tier-based scheduling
```

**Issues:**
1. Fixed batch size doesn't adapt to tier distribution
2. No intelligent prioritization
3. Inefficient for mixed activity levels

---

## 2. Smart Scheduler Integration Design

### 2.1 Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                     Vercel Cron Jobs                        │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌──────────────────┐        ┌──────────────────┐         │
│  │ calculate-tiers  │        │ fetch-traders    │         │
│  │  (every 15min)   │        │  (dynamic)       │         │
│  └────────┬─────────┘        └────────┬─────────┘         │
│           │                           │                    │
│           ▼                           ▼                    │
│  ┌─────────────────────────────────────────────┐          │
│  │        Schedule Manager Service             │          │
│  │  - classifyTraders()                        │          │
│  │  - getTradersToRefresh()                    │          │
│  │  - updateSchedule()                         │          │
│  └──────────────────┬──────────────────────────┘          │
│                     │                                      │
│                     ▼                                      │
│  ┌─────────────────────────────────────────────┐          │
│  │         Smart Scheduler Core                │          │
│  │  - classifyActivityTier()                   │          │
│  │  - scheduleTraderBatch()                    │          │
│  │  - shouldRefresh()                          │          │
│  └──────────────────┬──────────────────────────┘          │
│                     │                                      │
└─────────────────────┼──────────────────────────────────────┘
                      │
                      ▼
        ┌──────────────────────────┐
        │   Supabase Database      │
        │  - trader_sources        │
        │  - trader_schedules      │
        │  - trader_snapshots_v2   │
        └──────────────────────────┘
```

### 2.2 Tier Classification Strategy

**Activity Tiers (from smart-scheduler.ts):**

| Tier | Criteria | Refresh Interval | Priority | Example |
|------|----------|------------------|----------|---------|
| **Hot** | Rank ≤100 OR Followers >10k OR Views >1k/day | 15 min | 10 | Top traders |
| **Active** | Rank 101-500 OR Last trade <24h OR Followers >1k | 60 min | 20 | Active traders |
| **Normal** | Rank 501-2000 OR Last trade <7d | 4 hours | 30 | Regular traders |
| **Dormant** | All others | 24 hours | 40 | Inactive traders |

**Classification Logic:**
```typescript
function classifyActivityTier(activity: TraderActivity): ActivityTier {
  // Hot tier: Top performers or high engagement
  if (rank <= 100 || viewsLast24h > 1000 || followers > 10000) {
    return 'hot'
  }

  // Active tier: Regular activity
  if (rank <= 500 || lastTradeWithin24h || followers > 1000) {
    return 'active'
  }

  // Normal tier: Moderate activity
  if (rank <= 2000 || lastTradeWithin7d) {
    return 'normal'
  }

  // Dormant: Low activity
  return 'dormant'
}
```

### 2.3 Database Schema Design

**Option A: Add columns to trader_sources (Recommended)**

```sql
ALTER TABLE trader_sources ADD COLUMN IF NOT EXISTS
  activity_tier VARCHAR(20),           -- 'hot', 'active', 'normal', 'dormant'
  next_refresh_at TIMESTAMPTZ,         -- Next scheduled refresh time
  last_refreshed_at TIMESTAMPTZ,       -- Last successful refresh
  refresh_priority INTEGER,            -- Calculated priority (10-40)
  tier_updated_at TIMESTAMPTZ;         -- When tier was last calculated

CREATE INDEX idx_trader_sources_schedule
  ON trader_sources(activity_tier, next_refresh_at)
  WHERE is_active = true;

CREATE INDEX idx_trader_sources_refresh_priority
  ON trader_sources(refresh_priority, next_refresh_at)
  WHERE is_active = true;
```

**Option B: Create separate trader_schedules table**

```sql
CREATE TABLE trader_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform TEXT NOT NULL,
  trader_key TEXT NOT NULL,
  activity_tier VARCHAR(20) NOT NULL,
  next_refresh_at TIMESTAMPTZ NOT NULL,
  last_refreshed_at TIMESTAMPTZ,
  refresh_priority INTEGER NOT NULL,
  tier_calculated_at TIMESTAMPTZ DEFAULT NOW(),
  metrics JSONB,  -- Store classification metrics
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(platform, trader_key)
);

CREATE INDEX idx_trader_schedules_refresh
  ON trader_schedules(activity_tier, next_refresh_at);
```

**Decision: Use Option A (Add columns to trader_sources)**
- Simpler queries (no joins needed)
- Better performance
- Easier to maintain
- Consistent with existing schema

---

## 3. Integration Points

### 3.1 Calculate Tiers Cron Job

**New Endpoint:** `/api/cron/calculate-tiers/route.ts`

**Schedule:** Every 15 minutes

**Responsibilities:**
1. Fetch all active traders with recent snapshots
2. Call schedule-manager to classify into tiers
3. Update trader_sources with tier and next_refresh_at
4. Log tier distribution statistics

**Pseudocode:**
```typescript
export async function GET(req: Request) {
  // 1. Fetch traders with activity data
  const traders = await fetchTradersWithActivity()

  // 2. Classify into tiers
  const schedules = await scheduleManager.classifyTraders(traders)

  // 3. Update database
  await scheduleManager.updateSchedules(schedules)

  // 4. Return statistics
  return { tierStats, updateCount }
}
```

### 3.2 Modified Fetch Traders Endpoint

**Endpoint:** `/api/cron/fetch-traders/[platform]/route.ts`

**Changes:**
```typescript
// BEFORE: Fetch all traders
const traders = await getAllTraders(platform)

// AFTER: Fetch only traders due for refresh
const traders = await scheduleManager.getTradersToRefresh(platform, {
  limit: 500,
  includeOverdue: true,
})

// Process and update last_refreshed_at
await processTraders(traders)
await scheduleManager.markRefreshed(traders.map(t => t.id))
```

### 3.3 Modified Fetch Details Endpoint

**Endpoint:** `/api/cron/fetch-details/route.ts`

**Changes:**
```typescript
// BEFORE: Fixed limit and skipRecent
const limit = 200
const skipRecent = 6

// AFTER: Priority-based fetching
const traders = await scheduleManager.getTradersToRefresh(null, {
  limit: 300,
  priorityOrder: true,  // Fetch hot tier first
  includeOverdue: true,
})

// Adjust concurrency by tier
const concurrency = traders[0]?.activity_tier === 'hot' ? 50 : 30
```

### 3.4 Environment Variables

```env
# Smart Scheduler Configuration
ENABLE_SMART_SCHEDULER=true           # Feature flag
SMART_SCHEDULER_TIER_RECALC_MINUTES=15  # Tier recalculation frequency
SMART_SCHEDULER_STAGGER_MS=1000       # Stagger delay between jobs
SMART_SCHEDULER_MAX_BATCH_SIZE=500    # Max traders per batch
```

---

## 4. Schedule Manager Service Design

**File:** `lib/services/schedule-manager.ts`

**Key Functions:**

```typescript
export class ScheduleManager {
  /**
   * Classify all traders into activity tiers
   */
  async classifyTraders(
    platforms?: string[]
  ): Promise<ScheduledJob[]>

  /**
   * Get traders that need refreshing now
   */
  async getTradersToRefresh(options: {
    platform?: string
    limit?: number
    priorityOrder?: boolean
    includeOverdue?: boolean
  }): Promise<TraderWithSchedule[]>

  /**
   * Update schedules in database
   */
  async updateSchedules(
    schedules: ScheduledJob[]
  ): Promise<void>

  /**
   * Mark traders as refreshed
   */
  async markRefreshed(
    traderIds: string[]
  ): Promise<void>

  /**
   * Get tier statistics
   */
  async getTierStats(): Promise<TierStats>
}
```

---

## 5. Monitoring & Metrics

### 5.1 Key Metrics to Track

1. **Tier Distribution**
   - Count by tier (hot/active/normal/dormant)
   - Percentage distribution
   - Tier transition frequency

2. **API Call Efficiency**
   - Calls per hour by tier
   - Total API call reduction %
   - Cost savings estimate

3. **Data Freshness**
   - Average age by tier
   - % of traders updated on schedule
   - Overdue trader count

4. **System Performance**
   - Tier calculation duration
   - Schedule query performance
   - Database update latency

### 5.2 Monitoring Endpoints

**GET /api/admin/scheduler/stats**
```json
{
  "tierDistribution": {
    "hot": 150,
    "active": 800,
    "normal": 3000,
    "dormant": 8000
  },
  "apiCalls": {
    "last24h": 2400,
    "reduction": "65%",
    "costSavings": "$920/day"
  },
  "dataFreshness": {
    "hot": "12min avg",
    "active": "45min avg",
    "normal": "3.2h avg",
    "dormant": "18h avg"
  }
}
```

### 5.3 Logging Strategy

```typescript
// Tier classification logging
cronLogger.info('Tier classification complete', {
  totalTraders: 12000,
  hot: 150,
  active: 800,
  normal: 3000,
  dormant: 8000,
  duration: '1.2s',
})

// Refresh execution logging
cronLogger.info('Refresh batch complete', {
  platform: 'binance_futures',
  tier: 'hot',
  count: 150,
  duration: '45s',
  success: 148,
  failed: 2,
})
```

---

## 6. Backward Compatibility Strategy

### 6.1 Feature Flag Approach

```typescript
const ENABLE_SMART_SCHEDULER =
  process.env.ENABLE_SMART_SCHEDULER === 'true'

if (ENABLE_SMART_SCHEDULER) {
  // Use smart scheduler
  traders = await scheduleManager.getTradersToRefresh(...)
} else {
  // Fall back to current logic
  traders = await getAllTraders(...)
}
```

### 6.2 Gradual Rollout Plan

**Phase 1: Shadow Mode (Week 1)**
- Calculate tiers but don't use them
- Compare schedules with current approach
- Monitor metrics

**Phase 2: Partial Rollout (Week 2)**
- Enable for 1-2 platforms (e.g., Binance, Bybit)
- Monitor impact on API calls and freshness

**Phase 3: Full Rollout (Week 3)**
- Enable for all platforms
- Continue monitoring

**Phase 4: Optimization (Week 4+)**
- Tune tier thresholds
- Adjust refresh intervals
- Optimize batch sizes

### 6.3 Rollback Plan

If issues arise:
1. Set `ENABLE_SMART_SCHEDULER=false`
2. System reverts to current behavior immediately
3. No data loss (tier columns remain but unused)
4. Debug and fix issues
5. Re-enable when ready

---

## 7. Testing Strategy

### 7.1 Unit Tests

- `smart-scheduler.test.ts` - Tier classification logic
- `schedule-manager.test.ts` - Schedule management operations
- Edge cases: missing data, extreme values, tier transitions

### 7.2 Integration Tests

- End-to-end cron job execution
- Database update correctness
- Query performance with large datasets

### 7.3 Load Tests

- 10,000+ trader classification performance
- Concurrent cron job execution
- Database query optimization

### 7.4 Staging Environment Tests

- Run in staging for 1 week
- Compare API call volume
- Verify data freshness
- Check for errors

---

## 8. Performance Expectations

### 8.1 Expected Tier Distribution

Based on typical trading platform patterns:

| Tier | Count | % | Refresh/day | API Calls/day |
|------|-------|---|-------------|---------------|
| Hot | 150 | 1.25% | 96 | 14,400 |
| Active | 800 | 6.67% | 24 | 19,200 |
| Normal | 3,000 | 25% | 6 | 18,000 |
| Dormant | 8,050 | 67.08% | 1 | 8,050 |
| **Total** | **12,000** | **100%** | - | **59,650** |

**vs Current System:**
- Current: ~180,000 calls/day (every 4 hours for all)
- Smart: ~59,650 calls/day
- **Reduction: 67%**
- **Cost Savings: ~$27,690/month**

### 8.2 Database Query Performance

**Tier Classification Query:**
```sql
SELECT
  ts.id, ts.platform, ts.trader_key,
  ts.last_seen_at, tp.follower_count,
  tsv2.metrics->>'rank' as rank
FROM trader_sources ts
LEFT JOIN trader_profiles tp ON ts.platform = tp.platform
  AND ts.trader_key = tp.trader_key
LEFT JOIN trader_snapshots_v2 tsv2 ON ts.platform = tsv2.platform
  AND ts.trader_key = tsv2.trader_key
WHERE ts.is_active = true
  AND tsv2.window = '7D'
```

Expected: <2s for 12,000 traders with proper indexes

**Get Traders to Refresh:**
```sql
SELECT * FROM trader_sources
WHERE is_active = true
  AND next_refresh_at <= NOW()
ORDER BY refresh_priority ASC, next_refresh_at ASC
LIMIT 500
```

Expected: <100ms with indexes

---

## 9. Risk Analysis

### 9.1 Potential Risks

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| Hot traders not updated frequently enough | High | Low | Conservative thresholds, monitoring |
| Tier classification too slow | Medium | Medium | Optimize query, add indexes, cache |
| Database load increase | Medium | Low | Batch updates, rate limiting |
| Incorrect tier assignment | High | Low | Comprehensive tests, logging |

### 9.2 Fallback Mechanisms

1. **Feature flag** - Instant rollback
2. **Tier override** - Manual tier assignment for critical traders
3. **Health checks** - Auto-disable if errors exceed threshold
4. **Monitoring alerts** - Immediate notification of issues

---

## 10. Implementation Timeline

### Week 1: Foundation
- [x] Phase 1: Analysis and design ✅
- [ ] Phase 2: Move smart-scheduler to services
- [ ] Phase 3: Create schedule-manager
- [ ] Phase 4: Database migration

### Week 2: Integration
- [ ] Phase 5: Integrate into cron jobs
- [ ] Phase 6: Create tier calculation cron
- [ ] Phase 7: Add monitoring

### Week 3: Testing & Rollout
- [ ] Phase 8: Unit tests
- [ ] Phase 9: Update vercel.json
- [ ] Shadow mode deployment

### Week 4: Optimization
- [ ] Phase 10: Documentation
- [ ] Performance tuning
- [ ] Full rollout

---

## 11. Success Criteria

### Must Have
- ✅ API call reduction ≥60%
- ✅ Hot traders updated every 15-20 minutes
- ✅ No data freshness degradation for active traders
- ✅ Zero downtime deployment

### Nice to Have
- ✅ API call reduction ≥70%
- ✅ Real-time tier statistics dashboard
- ✅ Automated tier threshold tuning
- ✅ Per-platform tier optimization

---

## Appendix

### A. Smart Scheduler Configuration

```typescript
export const TIER_SCHEDULES: Record<ActivityTier, ScheduleConfig> = {
  hot: {
    intervalMinutes: 15,
    priority: 10,
    description: 'Top 100 traders - frequent updates',
  },
  active: {
    intervalMinutes: 60,
    priority: 20,
    description: 'Active traders (rank 101-500)',
  },
  normal: {
    intervalMinutes: 240,
    priority: 30,
    description: 'Normal traders (rank 501-2000)',
  },
  dormant: {
    intervalMinutes: 1440,
    priority: 40,
    description: 'Dormant traders (24h updates)',
  },
}
```

### B. Environment Variables Reference

```env
# Feature Flags
ENABLE_SMART_SCHEDULER=true

# Tier Configuration
SMART_SCHEDULER_TIER_RECALC_MINUTES=15
SMART_SCHEDULER_HOT_INTERVAL_MINUTES=15
SMART_SCHEDULER_ACTIVE_INTERVAL_MINUTES=60
SMART_SCHEDULER_NORMAL_INTERVAL_MINUTES=240
SMART_SCHEDULER_DORMANT_INTERVAL_MINUTES=1440

# Performance Tuning
SMART_SCHEDULER_MAX_BATCH_SIZE=500
SMART_SCHEDULER_STAGGER_MS=1000
SMART_SCHEDULER_CONCURRENCY_HOT=50
SMART_SCHEDULER_CONCURRENCY_DEFAULT=30

# Thresholds
SMART_SCHEDULER_HOT_RANK_THRESHOLD=100
SMART_SCHEDULER_HOT_FOLLOWERS_THRESHOLD=10000
SMART_SCHEDULER_HOT_VIEWS_THRESHOLD=1000
SMART_SCHEDULER_ACTIVE_RANK_THRESHOLD=500
SMART_SCHEDULER_ACTIVE_FOLLOWERS_THRESHOLD=1000
```

### C. Database Indexes

```sql
-- Scheduler indexes
CREATE INDEX idx_trader_sources_schedule
  ON trader_sources(activity_tier, next_refresh_at)
  WHERE is_active = true;

CREATE INDEX idx_trader_sources_refresh_priority
  ON trader_sources(refresh_priority, next_refresh_at)
  WHERE is_active = true;

CREATE INDEX idx_trader_sources_platform_tier
  ON trader_sources(platform, activity_tier, next_refresh_at)
  WHERE is_active = true;

-- Performance indexes
CREATE INDEX idx_trader_sources_last_refreshed
  ON trader_sources(last_refreshed_at DESC)
  WHERE is_active = true;

CREATE INDEX idx_trader_sources_tier_updated
  ON trader_sources(tier_updated_at)
  WHERE is_active = true;
```

---

**Document Version:** 1.0
**Last Updated:** 2026-01-28
**Author:** Smart Scheduler Integration Team
**Status:** Design Complete ✅
