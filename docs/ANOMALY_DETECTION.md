# Anomaly Detection System

This document consolidates the design, usage guide, and implementation details for the Ranking Arena Anomaly Detection system.

**Version**: 1.0.0
**Status**: Production Ready
**Last Updated**: 2026-01-28

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Detection Algorithms](#detection-algorithms)
4. [Severity Classification](#severity-classification)
5. [Database Schema](#database-schema)
6. [Quick Start](#quick-start)
7. [Configuration](#configuration)
8. [Integration Guide](#integration-guide)
9. [Admin API Reference](#admin-api-reference)
10. [Troubleshooting](#troubleshooting)
11. [Best Practices](#best-practices)
12. [Performance](#performance)
13. [Future Enhancements](#future-enhancements)

---

## Overview

The Anomaly Detection System provides automated data quality monitoring and fraud detection for trader performance data. It uses statistical methods and pattern recognition to identify suspicious or inconsistent data points across multiple dimensions.

### Key Features

- **Automated Detection**: Runs during data import and via scheduled cron jobs
- **Multi-Algorithm**: Z-Score, IQR, and pattern recognition
- **Severity Classification**: Critical, High, Medium, Low
- **Admin Dashboard**: Review and manage anomalies via API
- **Configurable Thresholds**: Adjust via environment variables

### What Gets Detected

1. **Statistical Outliers**: Extreme values (ROI, win rate, drawdown)
2. **Data Inconsistencies**: Invalid ranges, contradictory values
3. **Suspicious Patterns**: Unrealistic performance indicators

---

## Architecture

```
+---------------------------------------------------------+
|                    Data Import Layer                      |
|  (scripts/import/*.mjs + anomaly-helper.mjs)            |
+---------------------------+-----------------------------+
                            |
                            v
+---------------------------------------------------------+
|              Anomaly Detection Service                   |
|  (lib/services/anomaly-detection.ts)                    |
|  - Z-Score Detection                                    |
|  - IQR Detection                                        |
|  - Multi-dimensional Analysis                           |
|  - Pattern Recognition                                  |
|  - Severity Classification                              |
+---------------------------+-----------------------------+
                            |
                            v
+---------------------------------------------------------+
|              Anomaly Manager Service                     |
|  (lib/services/anomaly-manager.ts)                      |
|  - Batch Processing                                     |
|  - Database Persistence                                 |
|  - Query & Retrieval                                    |
|  - Status Management                                    |
+---------------------------+-----------------------------+
                            |
                            v
+---------------------------------------------------------+
|                Database Layer                             |
|  - trader_anomalies (records)                           |
|  - trader_anomaly_stats (per-trader view)               |
|  - platform_anomaly_stats (platform-wide view)          |
+---------------------------+-----------------------------+
                            |
                            v
+---------------------------------------------------------+
|                  Admin API Layer                          |
|  - GET /api/admin/anomalies (list)                      |
|  - GET /api/admin/anomalies/[id] (details)              |
|  - PATCH /api/admin/anomalies/[id] (update)             |
|  - GET /api/admin/anomalies/stats (statistics)          |
+---------------------------------------------------------+
```

---

## Detection Algorithms

### 1. Z-Score Detection

Statistical outlier detection using standard deviations.

```
Z = (X - mean) / stddev
Outlier if |Z| > threshold (default: 2.5)
```

- Works well with normal distributions
- Minimum sample size: 10
- Applied to: ROI, win rate, drawdown, trades count, PnL

### 2. IQR (Interquartile Range) Detection

Non-parametric outlier detection using quartiles.

```
IQR = Q3 - Q1
Lower Bound = Q1 - (multiplier x IQR)
Upper Bound = Q3 + (multiplier x IQR)
Outlier if X < Lower Bound OR X > Upper Bound
```

- Resistant to outliers, no distribution assumptions
- Default multiplier: 1.5

### 3. Multi-Dimensional Analysis

Combines multiple metrics into a composite anomaly score:

| Metric | Weight |
|--------|--------|
| ROI | 35% |
| Max Drawdown | 25% |
| Win Rate | 20% |
| Trades Count | 10% |
| PnL | 10% |

Classified as anomaly if score > 0.3 or 2+ anomaly types detected.

### 4. Pattern Recognition

- **Data Inconsistencies**: ROI > 1000% or < -99%, win rate outside 0-100%, low PnL with high ROI
- **Suspicious Patterns**: Win rate > 95%, almost no drawdown (<1%) with high ROI (>50%), very few trades (<3) with high ROI (>100%)
- **Time Series**: Sudden equity curve jumps, abnormal return patterns

---

## Severity Classification

```
Critical: Z-Score > 5.0 OR data inconsistency + other type
High:     Z-Score > 4.0 OR suspicious pattern + statistical outlier
Medium:   Z-Score > 3.0 OR 2+ anomaly types
Low:      Everything else
```

| Level | Description | Action Required |
|-------|-------------|-----------------|
| Critical | Major data quality issues | Immediate review |
| High | Significant anomalies | Review within 24h |
| Medium | Moderate anomalies | Review within week |
| Low | Minor anomalies | Periodic review |

---

## Database Schema

### trader_anomalies Table

```sql
CREATE TABLE trader_anomalies (
  id UUID PRIMARY KEY,
  trader_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  anomaly_type TEXT NOT NULL,
  field_name TEXT NOT NULL,
  detected_value NUMERIC,
  expected_range_min NUMERIC,
  expected_range_max NUMERIC,
  z_score NUMERIC,
  severity TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  description TEXT,
  detected_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  resolved_by UUID,
  notes TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
);
```

**Migration**: `supabase/migrations/00027_anomaly_detection.sql`

### Key Indexes

- `idx_trader_anomalies_trader` -- Query by trader
- `idx_trader_anomalies_status` -- Pending anomalies
- `idx_trader_anomalies_severity` -- Critical/high anomalies
- `idx_trader_anomalies_detected_at` -- Recent anomalies
- `idx_trader_anomalies_status_severity` -- Admin dashboard

### RLS Policies

- Admins can view all anomalies
- Public sees confirmed anomalies only
- Service role has full access

---

## Quick Start

### 1. Enable Anomaly Detection

```bash
# .env
ENABLE_ANOMALY_DETECTION=true
```

### 2. Run Database Migration

```bash
npx supabase db push
```

### 3. Set Up Cron Job

Add to `vercel.json`:

```json
{
  "crons": [
    {
      "path": "/api/cron/detect-anomalies",
      "schedule": "0 3 * * *"
    }
  ]
}
```

### 4. Verify Installation

```bash
curl -X POST https://your-domain.com/api/cron/detect-anomalies \
  -H "Authorization: Bearer YOUR_CRON_SECRET"
```

---

## Configuration

### Environment Variables

```bash
# Core
ENABLE_ANOMALY_DETECTION=true
CRON_SECRET=your-secret-here

# Detection thresholds (optional, defaults shown)
ANOMALY_DETECTION_Z_SCORE_THRESHOLD=2.5
ANOMALY_DETECTION_IQR_MULTIPLIER=1.5
ANOMALY_DETECTION_MIN_SAMPLE_SIZE=10
```

### Tuning Sensitivity

More sensitive (detect more): `ANOMALY_DETECTION_Z_SCORE_THRESHOLD=2.0`
Less sensitive (fewer false positives): `ANOMALY_DETECTION_Z_SCORE_THRESHOLD=3.0`

---

## Integration Guide

### Import Scripts (.mjs)

```javascript
import { detectAndSaveAnomalies } from '../../lib/services/anomaly-helper.mjs'

const traders = await fetchAllTraders()
const { detected, saved } = await detectAndSaveAnomalies(
  traders.map(t => ({
    id: t.traderId,
    roi: t.roi || 0,
    pnl: t.pnl || 0,
    win_rate: t.winRate,
    max_drawdown: t.maxDrawdown,
    trades_count: t.totalTrades,
  })),
  'binance_futures'
)
```

### TypeScript API Routes

```typescript
import {
  detectTraderAnomalies,
  saveAnomalies,
} from '@/lib/services/anomaly-manager'

const anomalies = await detectTraderAnomalies(traderId, platform, traderData)
if (anomalies.length > 0) {
  await saveAnomalies(anomalies)
}
```

---

## Admin API Reference

### List Anomalies

```http
GET /api/admin/anomalies?status=pending&severity=critical&limit=50&offset=0
```

### Get Anomaly Details

```http
GET /api/admin/anomalies/[id]
```

### Update Anomaly Status

```http
PATCH /api/admin/anomalies/[id]
Content-Type: application/json

{
  "status": "confirmed",
  "notes": "Verified as data quality issue"
}
```

Available statuses: `confirmed`, `false_positive`, `resolved`

### Get Statistics

```http
GET /api/admin/anomalies/stats
```

Returns total anomalies, breakdowns by severity/status/platform, affected trader count, and recent detection counts.

### Cron Trigger

```http
POST /api/cron/detect-anomalies
Authorization: Bearer [CRON_SECRET]
```

---

## Troubleshooting

### No Anomalies Detected
1. Check minimum sample size (need 10+ traders)
2. Verify `ENABLE_ANOMALY_DETECTION=true`
3. May indicate data quality is good

### Too Many False Positives
1. Increase Z-Score threshold to 3.0
2. Mark non-issues as `false_positive`
3. Consider platform-specific thresholds

### Detection Taking Too Long
1. Reduce batch size
2. Focus on critical fields (ROI, PnL)
3. Ensure database indexes are created
4. Run `VACUUM ANALYZE trader_anomalies`

### Database Errors
1. Verify migration applied: `npx supabase db push`
2. Check `SUPABASE_SERVICE_ROLE_KEY` is set
3. Verify service role RLS policy

---

## Best Practices

### Review Cadence
- **Daily**: Check critical anomalies
- **Weekly**: Review all pending anomalies
- **Monthly**: Analyze false positive rate, adjust thresholds

### Data Quality Workflow

```
1. Anomaly Detected
2. Admin Review (within 24h for critical)
3. Verify with Source Data
4. Mark Status (confirmed / false_positive / resolved)
5. Update Documentation
```

### Key Metrics to Track
- Detection rate: ~5-10% is normal
- Critical anomalies: Should be < 1%
- False positive rate: Target < 20%
- Resolution time: Target < 48h for critical

---

## Performance

| Operation | Traders | Time | Memory |
|-----------|---------|------|--------|
| Z-Score Detection | 100 | 5ms | <1MB |
| Multi-dimensional | 100 | 50ms | 2MB |
| Batch with DB save | 500 | 250ms | 10MB |
| Cron job (full) | 1500 | 850ms | 25MB |

- All detection runs in-memory before database writes
- Database writes are batched
- Performance scales linearly

---

## Future Enhancements

### Phase 2 (Q2 2026)
- Machine learning integration (train on confirmed anomalies)
- Frontend admin dashboard for anomaly review
- Advanced patterns: copy trading, wash trading detection
- Adaptive thresholds

### Phase 3 (Q3 2026)
- Real-time detection via stream processing
- WebSocket alerts for immediate notification
- Trader reputation score and trust badges

---

## File Structure

```
lib/services/
  anomaly-detection.ts          # Core detection logic (489 lines)
  anomaly-manager.ts            # Database operations (420 lines)
  anomaly-helper.mjs            # Import script helper (350 lines)
  __tests__/
    anomaly-detection.test.ts   # Test suite (600+ lines, 34 tests)

app/api/
  cron/detect-anomalies/route.ts
  admin/anomalies/
    route.ts                    # List API
    [id]/route.ts               # Detail/Update API
    stats/route.ts              # Statistics API

supabase/migrations/
  00027_anomaly_detection.sql   # Database schema
```

---

## References

- [Z-Score (Wikipedia)](https://en.wikipedia.org/wiki/Standard_score)
- [Interquartile Range (Wikipedia)](https://en.wikipedia.org/wiki/Interquartile_range)

---

> Consolidated from: ANOMALY_DETECTION_DESIGN.md, ANOMALY_DETECTION_GUIDE.md, ANOMALY_DETECTION_SUMMARY.md
