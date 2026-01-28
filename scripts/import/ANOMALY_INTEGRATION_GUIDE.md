# Anomaly Detection Integration Guide for Import Scripts

## Overview

This guide shows how to integrate anomaly detection into data import scripts to automatically flag suspicious trader data.

## Quick Integration

### 1. Import the Helper

```javascript
import { detectAndSaveAnomalies } from '../../lib/services/anomaly-helper.mjs'
```

### 2. Add Detection Before Saving

Add anomaly detection after fetching trader data but before saving to database:

```javascript
// After fetching all trader data
const tradersWithDetails = await fetchAllDetails(traders, period, concurrency)

// NEW: Detect anomalies
console.log('\n🔍 Detecting anomalies...')
const { detected, saved } = await detectAndSaveAnomalies(
  tradersWithDetails.map(t => ({
    id: t.traderId,
    roi: t.roi || 0,
    pnl: t.pnl || 0,
    win_rate: t.winRate,
    max_drawdown: t.maxDrawdown,
    trades_count: t.totalTrades,
  })),
  SOURCE  // e.g., 'binance_futures'
)

if (detected > 0) {
  console.log(`  ⚠️  Detected ${detected} traders with anomalies (${saved} anomalies saved)`)
}

// Continue with normal save process
await saveTradersBatch(tradersWithDetails, period)
```

## Example: Binance Futures Integration

Here's a complete example for `import_binance_futures_api.mjs`:

```javascript
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
import pLimit from 'p-limit'
import { detectAndSaveAnomalies } from '../../lib/services/anomaly-helper.mjs'

const SOURCE = 'binance_futures'

// ... existing code ...

async function fetchAndSaveLeaderboard(period) {
  // 1. Fetch leaderboard
  const traders = await fetchLeaderboard(period)

  // 2. Fetch details
  const tradersWithDetails = await fetchAllDetails(traders, period, getConcurrency())

  // 3. NEW: Detect anomalies
  console.log('\n🔍 Detecting anomalies...')
  try {
    const { detected, saved } = await detectAndSaveAnomalies(
      tradersWithDetails.map(t => ({
        id: t.traderId,
        roi: t.roi || 0,
        pnl: t.pnl || 0,
        win_rate: t.winRate,
        max_drawdown: t.maxDrawdown,
        trades_count: t.totalTrades,
      })),
      SOURCE
    )

    if (detected > 0) {
      console.log(`  ⚠️  Detected ${detected} traders with anomalies (${saved} anomalies saved)`)
    } else {
      console.log(`  ✓ No anomalies detected`)
    }
  } catch (error) {
    console.error(`  ❌ Anomaly detection failed:`, error.message)
    // Continue with import even if anomaly detection fails
  }

  // 4. Save to database
  await saveTradersBatch(tradersWithDetails, period)
}
```

## Data Format

The anomaly detection expects trader data in this format:

```javascript
{
  id: string,              // Trader ID
  roi: number,             // ROI percentage
  pnl: number,             // Total PnL
  win_rate: number,        // Win rate (0-100 or 0-1, will be normalized)
  max_drawdown: number,    // Max drawdown percentage (negative)
  trades_count: number,    // Total number of trades
}
```

## What Gets Detected

The system automatically detects:

1. **Statistical Outliers** (Z-Score > 2.5)
   - Extreme ROI values
   - Unusual win rates
   - Abnormal drawdown values

2. **Data Inconsistencies**
   - ROI > 1000% or < -99%
   - Win rate outside 0-100%
   - Low PnL with high ROI

3. **Suspicious Patterns**
   - Win rate > 95%
   - Almost no drawdown with high ROI
   - Very few trades with high ROI

## Severity Levels

- **Critical**: Z-Score > 5 or multiple severe issues
- **High**: Z-Score > 4 or suspicious pattern + outlier
- **Medium**: Z-Score > 3 or multiple minor issues
- **Low**: Everything else

## Configuration

Control via environment variables in `.env`:

```bash
# Enable/disable anomaly detection
ENABLE_ANOMALY_DETECTION=true

# Detection thresholds
ANOMALY_DETECTION_Z_SCORE_THRESHOLD=2.5
ANOMALY_DETECTION_IQR_MULTIPLIER=1.5
ANOMALY_DETECTION_MIN_SAMPLE_SIZE=10
```

## Viewing Results

After integration, anomalies can be viewed via:

1. **Admin API**:
   - `GET /api/admin/anomalies` - List all anomalies
   - `GET /api/admin/anomalies/stats` - Statistics
   - `PATCH /api/admin/anomalies/[id]` - Update status

2. **Database**:
   - `trader_anomalies` table
   - `trader_anomaly_stats` view (per trader)
   - `platform_anomaly_stats` view (platform-wide)

## Integration Checklist

- [ ] Import anomaly helper at top of script
- [ ] Add detection call after fetching trader data
- [ ] Map trader data to expected format
- [ ] Handle errors gracefully (don't break import)
- [ ] Log detection results
- [ ] Test with sample data
- [ ] Monitor anomaly stats via admin API

## Performance Impact

- **Minimal**: Detection runs in-memory before database save
- **Time**: ~50ms per 100 traders
- **Database**: Only anomalous traders create DB writes

## Troubleshooting

### No anomalies detected when expected

1. Check sample size: Need at least 10 traders
2. Check field values: Ensure data is numeric
3. Lower Z-Score threshold via env var

### Too many false positives

1. Increase Z-Score threshold to 3.0 or 3.5
2. Review and mark as false_positive via admin API
3. System will learn over time

### Detection errors

1. Check Supabase credentials
2. Verify database migration 00027 is applied
3. Check logs for specific error messages

## Next Steps

1. Integrate into all active import scripts
2. Set up monitoring dashboard
3. Review and confirm anomalies weekly
4. Fine-tune thresholds based on findings
