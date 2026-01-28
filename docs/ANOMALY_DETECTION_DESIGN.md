# Anomaly Detection System - Design Document

## Overview

The Anomaly Detection System provides automated data quality monitoring and fraud detection for trader performance data. It uses statistical methods and pattern recognition to identify suspicious or inconsistent data points across multiple dimensions.

**Version**: 1.0.0
**Status**: Production Ready
**Last Updated**: 2026-01-28

## Architecture

### System Components

```
┌─────────────────────────────────────────────────────────────┐
│                    Data Import Layer                         │
│  (scripts/import/*.mjs + anomaly-helper.mjs)                │
└────────────────┬────────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────────┐
│              Anomaly Detection Service                       │
│  (lib/services/anomaly-detection.ts)                        │
│                                                              │
│  • Z-Score Detection                                        │
│  • IQR Detection                                            │
│  • Multi-dimensional Analysis                               │
│  • Pattern Recognition                                      │
│  • Severity Classification                                  │
└────────────────┬────────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────────┐
│              Anomaly Manager Service                         │
│  (lib/services/anomaly-manager.ts)                          │
│                                                              │
│  • Batch Processing                                         │
│  • Database Persistence                                     │
│  • Query & Retrieval                                        │
│  • Status Management                                        │
└────────────────┬────────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────────┐
│                Database Layer                                │
│  • trader_anomalies (records)                               │
│  • trader_anomaly_stats (per-trader view)                   │
│  • platform_anomaly_stats (platform-wide view)              │
└─────────────────────────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────────┐
│                  Admin API Layer                             │
│  • GET /api/admin/anomalies (list)                          │
│  • GET /api/admin/anomalies/[id] (details)                  │
│  • PATCH /api/admin/anomalies/[id] (update)                 │
│  • GET /api/admin/anomalies/stats (statistics)              │
└─────────────────────────────────────────────────────────────┘
```

## Detection Algorithms

### 1. Z-Score Based Detection

**Algorithm**: Statistical outlier detection using standard deviations.

```typescript
Z = (X - μ) / σ

Where:
- X = observed value
- μ = mean of population
- σ = standard deviation
- Outlier if |Z| > threshold (default: 2.5)
```

**Use Cases**:
- Detecting extreme ROI values
- Identifying unusual win rates
- Spotting abnormal drawdown values

**Advantages**:
- Mathematically rigorous
- Works well with normal distributions
- Easy to interpret (std deviations from mean)

**Limitations**:
- Sensitive to distribution shape
- Requires minimum sample size (default: 10)
- Can be affected by multiple outliers

### 2. IQR (Interquartile Range) Detection

**Algorithm**: Non-parametric outlier detection using quartiles.

```typescript
IQR = Q3 - Q1
Lower Bound = Q1 - (multiplier × IQR)
Upper Bound = Q3 + (multiplier × IQR)
Outlier if X < Lower Bound OR X > Upper Bound
```

**Use Cases**:
- Robust alternative to Z-Score
- Works with skewed distributions
- Identifying extreme values in any distribution

**Advantages**:
- Resistant to outliers
- No distribution assumptions
- Good for skewed data

### 3. Multi-Dimensional Detection

**Algorithm**: Combines multiple metrics to calculate composite anomaly score.

```typescript
Anomaly Score = Σ(weight_i × normalized_anomaly_i)

Weights:
- ROI: 35%
- Max Drawdown: 25%
- Win Rate: 20%
- PnL: 10%
- Trades Count: 10%

Classified as anomaly if:
- Score > 0.3, OR
- 2+ different anomaly types detected
```

**Use Cases**:
- Comprehensive trader evaluation
- Combining statistical and pattern-based detection
- Prioritizing anomalies by severity

### 4. Pattern Recognition

**Patterns Detected**:

1. **Data Inconsistencies**
   - ROI > 1000% or < -99%
   - Win rate outside 0-100%
   - Low PnL with high ROI

2. **Suspicious Patterns**
   - Win rate > 95%
   - Almost no drawdown (<1%) with high ROI (>50%)
   - Very few trades (<3) with high ROI (>100%)

3. **Time Series Anomalies**
   - Sudden equity curve jumps
   - Abnormal return patterns

## Severity Classification

### Classification Rules

```typescript
Critical:
- Z-Score > 5.0, OR
- Data inconsistency + 1+ other type

High:
- Z-Score > 4.0, OR
- Suspicious pattern + statistical outlier

Medium:
- Z-Score > 3.0, OR
- 2+ anomaly types

Low:
- Everything else
```

### Severity Levels

| Level    | Description                      | Action Required     |
|----------|----------------------------------|---------------------|
| Critical | Major data quality issues        | Immediate review    |
| High     | Significant anomalies            | Review within 24h   |
| Medium   | Moderate anomalies               | Review within week  |
| Low      | Minor anomalies                  | Periodic review     |

## Database Schema

### trader_anomalies Table

```sql
CREATE TABLE trader_anomalies (
  id UUID PRIMARY KEY,
  trader_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  anomaly_type TEXT NOT NULL,      -- Comma-separated types
  field_name TEXT NOT NULL,         -- Field with anomaly
  detected_value NUMERIC,           -- Actual value
  expected_range_min NUMERIC,       -- Expected min (if applicable)
  expected_range_max NUMERIC,       -- Expected max (if applicable)
  z_score NUMERIC,                  -- Z-Score (if applicable)
  severity TEXT NOT NULL,           -- critical/high/medium/low
  status TEXT DEFAULT 'pending',    -- pending/confirmed/false_positive/resolved
  description TEXT,                 -- Human-readable description
  detected_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  resolved_by UUID,
  notes TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
);
```

### Indexes

```sql
-- Query by trader
CREATE INDEX idx_trader_anomalies_trader
  ON trader_anomalies(trader_id, platform);

-- Pending anomalies
CREATE INDEX idx_trader_anomalies_status
  ON trader_anomalies(status)
  WHERE status = 'pending';

-- Critical anomalies
CREATE INDEX idx_trader_anomalies_severity
  ON trader_anomalies(severity)
  WHERE severity IN ('high', 'critical');

-- Recent anomalies
CREATE INDEX idx_trader_anomalies_detected_at
  ON trader_anomalies(detected_at DESC);

-- Admin dashboard
CREATE INDEX idx_trader_anomalies_status_severity
  ON trader_anomalies(status, severity, detected_at DESC);
```

## API Design

### Admin Endpoints

#### 1. List Anomalies

```http
GET /api/admin/anomalies?status=pending&severity=critical&limit=50&offset=0
```

**Response**:
```json
{
  "success": true,
  "data": [
    {
      "id": "uuid",
      "trader_id": "123",
      "platform": "binance_futures",
      "anomaly_type": "statistical_outlier,suspicious_pattern",
      "field_name": "roi",
      "detected_value": 500,
      "z_score": 4.5,
      "severity": "high",
      "status": "pending",
      "description": "ROI Z-Score: 4.50",
      "detected_at": "2026-01-28T00:00:00Z"
    }
  ],
  "meta": {
    "limit": 50,
    "offset": 0,
    "has_more": true
  }
}
```

#### 2. Get Anomaly Details

```http
GET /api/admin/anomalies/[id]
```

#### 3. Update Anomaly Status

```http
PATCH /api/admin/anomalies/[id]
Content-Type: application/json

{
  "status": "confirmed",
  "notes": "Verified as data quality issue"
}
```

#### 4. Get Statistics

```http
GET /api/admin/anomalies/stats
```

**Response**:
```json
{
  "success": true,
  "data": {
    "total_anomalies": 1234,
    "by_severity": {
      "critical": 50,
      "high": 200,
      "medium": 500,
      "low": 484
    },
    "by_status": {
      "pending": 800,
      "confirmed": 300,
      "false_positive": 100,
      "resolved": 34
    },
    "by_platform": {
      "binance_futures": 600,
      "bybit": 400,
      "bitget_futures": 234
    },
    "affected_traders": 890,
    "last_24h": 45,
    "last_7d": 320
  }
}
```

## Configuration

### Environment Variables

```bash
# Enable/disable anomaly detection
ENABLE_ANOMALY_DETECTION=true

# Detection thresholds
ANOMALY_DETECTION_Z_SCORE_THRESHOLD=2.5
ANOMALY_DETECTION_IQR_MULTIPLIER=1.5
ANOMALY_DETECTION_MIN_SAMPLE_SIZE=10

# Not yet implemented (use defaults):
# ANOMALY_SEVERITY_CRITICAL_THRESHOLD=5.0
# ANOMALY_SEVERITY_HIGH_THRESHOLD=4.0
# ANOMALY_SEVERITY_MEDIUM_THRESHOLD=3.0
```

### Default Configuration

```typescript
{
  Z_SCORE_THRESHOLD: 2.5,
  IQR_MULTIPLIER: 1.5,
  MIN_SAMPLE_SIZE: 10,
  WEIGHTS: {
    roi: 0.35,
    win_rate: 0.2,
    max_drawdown: 0.25,
    trades_count: 0.1,
    pnl: 0.1,
  },
  THRESHOLDS: {
    ROI_MAX: 1000,
    ROI_MIN: -99,
    WIN_RATE_MAX: 100,
    WIN_RATE_MIN: 0,
    WIN_RATE_SUSPICIOUS: 95,
    DRAWDOWN_SUSPICIOUS_LOW: 1,
    TRADES_MIN: 3,
    MIN_PNL_FOR_HIGH_ROI: 1000,
  },
  SEVERITY: {
    CRITICAL_Z_SCORE: 5.0,
    HIGH_Z_SCORE: 4.0,
    MEDIUM_Z_SCORE: 3.0,
  },
}
```

## Performance Considerations

### Computational Complexity

- **Z-Score Detection**: O(n) per field, O(nf) total (n=traders, f=fields)
- **Multi-dimensional**: O(nf) for all traders
- **Memory**: O(n) for storing results

### Optimization Strategies

1. **In-Memory Processing**: All detection runs in-memory before DB writes
2. **Batch Processing**: Group anomalies by trader for bulk insert
3. **Selective Fields**: Only analyze relevant fields (skip nulls)
4. **Minimal Sample Size**: Skip detection if < 10 traders

### Expected Performance

- **100 traders**: ~50ms
- **500 traders**: ~200ms
- **1000 traders**: ~400ms

## Security & Privacy

### Access Control

- **Detection**: Service role only (cron + import scripts)
- **Admin API**: Requires admin authentication
- **Public View**: Only confirmed anomalies visible

### RLS Policies

```sql
-- Admins see all
CREATE POLICY "Admins can view all anomalies"
  ON trader_anomalies FOR SELECT
  USING (user_is_admin());

-- Public sees confirmed only
CREATE POLICY "Confirmed anomalies are public"
  ON trader_anomalies FOR SELECT
  USING (status = 'confirmed');

-- Service role can do everything
CREATE POLICY "Service role full access"
  ON trader_anomalies FOR ALL
  USING (auth.jwt()->>'role' = 'service_role');
```

## Monitoring & Alerting

### Key Metrics

1. **Detection Rate**: % of traders flagged
2. **False Positive Rate**: % of anomalies marked as false positives
3. **Critical Anomalies**: Count of critical/high severity pending
4. **Resolution Time**: Time from detection to resolution

### Recommended Alerts

- Critical anomalies pending > 24h
- False positive rate > 30%
- Detection failures in import scripts

## Future Enhancements

### Phase 2 (Q2 2026)

1. **Machine Learning**
   - Train models on confirmed anomalies
   - Improve false positive rate
   - Adaptive thresholds

2. **Advanced Pattern Recognition**
   - Trading strategy classification
   - Copy trading pattern detection
   - Wash trading detection

3. **Automated Actions**
   - Auto-flag suspicious traders
   - Temporary data hiding
   - Notification system

### Phase 3 (Q3 2026)

1. **Real-time Detection**
   - Stream processing
   - Immediate alerts
   - WebSocket notifications

2. **Trader Reputation Score**
   - Historical anomaly tracking
   - Trust score calculation
   - Badge system

## References

- [Z-Score (Wikipedia)](https://en.wikipedia.org/wiki/Standard_score)
- [Interquartile Range (Wikipedia)](https://en.wikipedia.org/wiki/Interquartile_range)
- Statistical Quality Control Methods
