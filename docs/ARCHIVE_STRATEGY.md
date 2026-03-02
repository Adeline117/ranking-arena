# Archive Strategy - Current vs Historical Leaderboard Data

**Decided**: 2026-03-02  
**Policy**: Permanent retention, separated storage

## 📋 Requirements

1. **永久保留** - All trader data (current + historical)
2. **分离存储** - Distinguish active leaderboard from archived
3. **全量enrichment** - Both current and historical traders get enriched

## 🗄️ Database Design

### Option A: Status Flag (Simple)
Add `status` column to existing `leaderboard_ranks`:
- `current` - Currently on leaderboard
- `archived` - Dropped from leaderboard but retained

**Pros**: 
- Minimal schema change
- Easy to query both
- No data migration needed

**Cons**:
- Mixed data in one table
- Indexes less efficient

### Option B: Separate Tables (Clean)
Split into two tables:
- `leaderboard_current` - Active traders only
- `leaderboard_archive` - Historical traders

**Pros**:
- Clean separation
- Optimized queries
- Better performance

**Cons**:
- More complex migration
- Need sync logic
- Duplicate schema

### Option C: Hybrid (Recommended) ✅
Keep `leaderboard_ranks` for current + add `leaderboard_history`:

```sql
-- Current table (existing, no change)
leaderboard_ranks
  - Active traders only
  - Updated by daily imports

-- New history table
leaderboard_history
  - Snapshot of dropped traders
  - source, source_trader_id, archived_at
  - Full snapshot data preserved
```

**Pros**:
- Backward compatible
- History isolated but accessible
- Can rebuild history from snapshots

**Cons**:
- Need archival cron job

## 📊 Implementation Plan

### Phase 1: Schema Addition (Now)
```sql
CREATE TABLE leaderboard_history (
  id BIGSERIAL PRIMARY KEY,
  source TEXT NOT NULL,
  source_trader_id TEXT NOT NULL,
  season_id TEXT,
  handle TEXT,
  avatar_url TEXT,
  win_rate NUMERIC,
  max_drawdown NUMERIC,
  trades_count INTEGER,
  roi NUMERIC,
  pnl NUMERIC,
  followers INTEGER,
  roi_7d NUMERIC,
  roi_30d NUMERIC,
  roi_90d NUMERIC,
  win_rate_7d NUMERIC,
  win_rate_30d NUMERIC,
  win_rate_90d NUMERIC,
  max_drawdown_7d NUMERIC,
  max_drawdown_30d NUMERIC,
  max_drawdown_90d NUMERIC,
  archived_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ, -- When last on leaderboard
  snapshot_data JSONB, -- Full data snapshot
  UNIQUE(source, source_trader_id, season_id, archived_at)
);

CREATE INDEX idx_history_source ON leaderboard_history(source);
CREATE INDEX idx_history_trader ON leaderboard_history(source, source_trader_id);
CREATE INDEX idx_history_archived ON leaderboard_history(archived_at DESC);
```

### Phase 2: Archive Detection (Daily Cron)
```javascript
// scripts/archive-dropped-traders.mjs
// Run daily after import:
// 1. Get current leaderboard snapshot from APIs
// 2. Compare with leaderboard_ranks
// 3. Move dropped traders to leaderboard_history
// 4. Delete from leaderboard_ranks OR mark as archived
```

### Phase 3: Enrichment Updates
```javascript
// Enrichment scripts search BOTH tables:
// 1. Try leaderboard_ranks first
// 2. If not found, search leaderboard_history
// 3. Update whichever table has the trader
```

## 🔄 Archival Flow

```
Daily Import
     ↓
New leaderboard data arrives
     ↓
Compare with existing leaderboard_ranks
     ↓
Found traders NOT in new data?
     ↓
Move to leaderboard_history + DELETE from ranks
     ↓
Import new traders to leaderboard_ranks
```

## 📈 Enrichment Strategy

### Current Traders
- **Source**: Latest API data
- **Frequency**: Daily
- **Priority**: High

### Historical Traders
- **Source**: Archived snapshots + enrichment APIs (if still accessible)
- **Frequency**: Weekly
- **Priority**: Medium

### Unreachable Traders
- **Accept**: Some historical traders may become permanently unreachable
- **Mark**: `enrichment_status = 'api_unavailable'`
- **Retry**: Monthly (in case they return to rankings)

## 🎯 Queries

### Get current leaderboard
```sql
SELECT * FROM leaderboard_ranks
WHERE source = 'binance_web3'
ORDER BY roi DESC;
```

### Get trader history
```sql
SELECT * FROM leaderboard_history
WHERE source = 'binance_web3'
  AND source_trader_id = '0x...'
ORDER BY archived_at DESC;
```

### Get all data for a trader (current + history)
```sql
SELECT 'current' as status, * FROM leaderboard_ranks
WHERE source = 'binance_web3' AND source_trader_id = '0x...'
UNION ALL
SELECT 'archived' as status, * FROM leaderboard_history
WHERE source = 'binance_web3' AND source_trader_id = '0x...'
ORDER BY archived_at DESC NULLS FIRST;
```

## 🚀 Migration Script

See: `scripts/migrate-to-archive-strategy.mjs`

Steps:
1. Create leaderboard_history table
2. Identify dropped traders (compare DB vs current API)
3. Copy to history table
4. Verify counts
5. (Optional) Clean up leaderboard_ranks

## 📊 Monitoring

Track daily:
- Active traders count (leaderboard_ranks)
- Archived traders count (leaderboard_history)
- New archives per day
- Enrichment coverage (both tables)

## 🔧 Tools

1. `scripts/archive-dropped-traders.mjs` - Daily archival
2. `scripts/enrich-historical-traders.mjs` - Weekly historical enrichment
3. `scripts/stats-archive-health.mjs` - Monitor archive health
