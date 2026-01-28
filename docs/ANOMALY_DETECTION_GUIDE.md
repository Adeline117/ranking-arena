# Anomaly Detection System - User Guide

## Table of Contents

1. [Introduction](#introduction)
2. [Quick Start](#quick-start)
3. [Configuration](#configuration)
4. [Integration Guide](#integration-guide)
5. [Admin Dashboard Usage](#admin-dashboard-usage)
6. [API Reference](#api-reference)
7. [Troubleshooting](#troubleshooting)
8. [Best Practices](#best-practices)

## Introduction

The Anomaly Detection System automatically identifies suspicious or inconsistent trader data to improve data quality and detect potential fraud. It runs during data import and via scheduled cron jobs.

### Key Features

- **Automated Detection**: Runs automatically during data import
- **Multi-Algorithm**: Uses Z-Score, IQR, and pattern recognition
- **Severity Classification**: Critical, High, Medium, Low
- **Admin Dashboard**: Review and manage anomalies
- **Configurable**: Adjust thresholds via environment variables

### What Gets Detected

1. **Statistical Outliers**: Extreme values (ROI, win rate, drawdown)
2. **Data Inconsistencies**: Invalid ranges, contradictory values
3. **Suspicious Patterns**: Unrealistic performance indicators

## Quick Start

### 1. Enable Anomaly Detection

Add to `.env`:

```bash
ENABLE_ANOMALY_DETECTION=true
```

### 2. Run Database Migration

```bash
# Apply migration 00027
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
# Manually trigger detection
curl -X POST https://your-domain.com/api/cron/detect-anomalies \
  -H "Authorization: Bearer YOUR_CRON_SECRET"
```

## Configuration

### Environment Variables

```bash
# Core settings
ENABLE_ANOMALY_DETECTION=true
CRON_SECRET=your-secret-here

# Detection thresholds (optional - defaults shown)
ANOMALY_DETECTION_Z_SCORE_THRESHOLD=2.5
ANOMALY_DETECTION_IQR_MULTIPLIER=1.5
ANOMALY_DETECTION_MIN_SAMPLE_SIZE=10
```

### Tuning Thresholds

**More Sensitive** (detect more anomalies):
```bash
ANOMALY_DETECTION_Z_SCORE_THRESHOLD=2.0
```

**Less Sensitive** (fewer false positives):
```bash
ANOMALY_DETECTION_Z_SCORE_THRESHOLD=3.0
```

## Integration Guide

### Import Scripts

#### Step 1: Import Helper

```javascript
import { detectAndSaveAnomalies } from '../../lib/services/anomaly-helper.mjs'
```

#### Step 2: Add Detection

```javascript
// After fetching trader data
const traders = await fetchAllTraders()

// Detect anomalies
console.log('🔍 Detecting anomalies...')
const { detected, saved } = await detectAndSaveAnomalies(
  traders.map(t => ({
    id: t.traderId,
    roi: t.roi || 0,
    pnl: t.pnl || 0,
    win_rate: t.winRate,
    max_drawdown: t.maxDrawdown,
    trades_count: t.totalTrades,
  })),
  'binance_futures'  // Platform name
)

if (detected > 0) {
  console.log(`⚠️  Found ${detected} traders with anomalies`)
}

// Continue with normal save
await saveToDatabase(traders)
```

### TypeScript/Next.js API Routes

```typescript
import {
  detectTraderAnomalies,
  saveAnomalies,
} from '@/lib/services/anomaly-manager'

// Detect anomalies for a single trader
const anomalies = await detectTraderAnomalies(
  traderId,
  platform,
  {
    id: traderId,
    platform,
    roi: 150,
    pnl: 15000,
    win_rate: 65,
    max_drawdown: -12,
    trades_count: 500,
  }
)

if (anomalies.length > 0) {
  await saveAnomalies(anomalies)
}
```

## Admin Dashboard Usage

### Viewing Anomalies

**List all pending critical anomalies**:

```bash
curl https://your-domain.com/api/admin/anomalies?status=pending&severity=critical \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

**Response**:
```json
{
  "success": true,
  "data": [
    {
      "id": "123e4567-e89b-12d3-a456-426614174000",
      "trader_id": "trader123",
      "platform": "binance_futures",
      "field_name": "roi",
      "detected_value": 500,
      "severity": "critical",
      "description": "ROI Z-Score: 5.50",
      "detected_at": "2026-01-28T10:30:00Z"
    }
  ]
}
```

### Reviewing Anomalies

**Get detailed information**:

```bash
curl https://your-domain.com/api/admin/anomalies/[anomaly-id] \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

### Updating Status

**Mark as confirmed**:

```bash
curl -X PATCH https://your-domain.com/api/admin/anomalies/[anomaly-id] \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "status": "confirmed",
    "notes": "Verified data quality issue with exchange API"
  }'
```

**Available statuses**:
- `confirmed`: Real data quality issue
- `false_positive`: Not an actual issue
- `resolved`: Issue has been fixed

### Statistics Dashboard

```bash
curl https://your-domain.com/api/admin/anomalies/stats \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

## API Reference

### Admin Endpoints

#### List Anomalies

```http
GET /api/admin/anomalies
```

**Query Parameters**:
- `status`: pending | confirmed | false_positive | resolved
- `severity`: critical | high | medium | low
- `platform`: Platform name (e.g., binance_futures)
- `limit`: Number of results (default: 50)
- `offset`: Pagination offset (default: 0)

#### Get Anomaly Details

```http
GET /api/admin/anomalies/[id]
```

#### Update Anomaly

```http
PATCH /api/admin/anomalies/[id]
```

**Body**:
```json
{
  "status": "confirmed",
  "notes": "Optional admin notes"
}
```

#### Get Statistics

```http
GET /api/admin/anomalies/stats
```

### Cron Endpoint

#### Trigger Detection

```http
POST /api/cron/detect-anomalies
```

**Headers**:
```
Authorization: Bearer [CRON_SECRET]
```

## Troubleshooting

### No Anomalies Detected

**Possible Causes**:

1. **Insufficient Sample Size**
   - Need at least 10 traders for statistical detection
   - Solution: Wait for more data or lower `MIN_SAMPLE_SIZE`

2. **Anomaly Detection Disabled**
   - Check: `ENABLE_ANOMALY_DETECTION=true` in `.env`

3. **Data Quality Too Good**
   - All values within normal ranges
   - This is actually good!

### Too Many False Positives

**Solutions**:

1. **Increase Z-Score Threshold**
   ```bash
   ANOMALY_DETECTION_Z_SCORE_THRESHOLD=3.0
   ```

2. **Review and Mark False Positives**
   - System learns from your feedback
   - Mark non-issues as `false_positive`

3. **Adjust Platform-Specific Thresholds**
   - Some platforms have different normal ranges
   - Consider separate configs per platform

### Detection Taking Too Long

**Optimizations**:

1. **Reduce Batch Size**
   - Process traders in smaller batches
   - Use pagination in cron job

2. **Skip Low-Priority Fields**
   - Focus on critical fields (ROI, PnL)
   - Skip optional metrics

3. **Database Optimization**
   - Ensure indexes are created
   - Run `VACUUM ANALYZE trader_anomalies`

### Database Errors

**Common Issues**:

1. **Migration Not Applied**
   ```bash
   npx supabase db push
   ```

2. **Missing Service Role Key**
   ```bash
   # Add to .env
   SUPABASE_SERVICE_ROLE_KEY=your-key
   ```

3. **RLS Policy Blocking Writes**
   - Verify service role has full access
   - Check `auth.jwt()->>'role' = 'service_role'` policy

## Best Practices

### 1. Regular Review

- **Daily**: Check critical anomalies
- **Weekly**: Review all pending anomalies
- **Monthly**: Analyze false positive rate

### 2. Continuous Improvement

- Mark false positives promptly
- Document common patterns
- Adjust thresholds based on findings

### 3. Integration Strategy

- Start with non-blocking (log only)
- Monitor for 1-2 weeks
- Gradually enable blocking for critical issues

### 4. Data Quality Workflow

```
1. Anomaly Detected
   ↓
2. Admin Review (within 24h for critical)
   ↓
3. Verify with Source Data
   ↓
4. Mark Status:
   - Confirmed → Contact platform or exclude data
   - False Positive → Adjust thresholds
   - Resolved → Update data and mark resolved
   ↓
5. Update Documentation
```

### 5. Monitoring

**Key Metrics to Track**:

- Detection rate: ~5-10% is normal
- Critical anomalies: Should be < 1%
- False positive rate: Target < 20%
- Resolution time: Target < 48h for critical

### 6. Backup and Recovery

```sql
-- Export anomalies for analysis
COPY (
  SELECT * FROM trader_anomalies
  WHERE detected_at > NOW() - INTERVAL '30 days'
) TO '/tmp/anomalies.csv' CSV HEADER;
```

## FAQ

**Q: Will anomaly detection slow down data imports?**
A: Minimal impact. Detection adds ~50ms per 100 traders and runs in-memory before database writes.

**Q: Can I disable detection for specific platforms?**
A: Yes, modify the import script to skip `detectAndSaveAnomalies` for that platform.

**Q: How do I export anomaly data for analysis?**
A: Use the admin API or direct SQL queries on `trader_anomalies` table.

**Q: What happens to traders with critical anomalies?**
A: They are flagged in the database but remain visible. Admins can decide whether to hide or flag them publicly.

**Q: Can I customize detection for different trader types?**
A: Currently no, but this is planned for Phase 2. You can adjust global thresholds via env vars.

## Support

For issues or questions:

1. Check this guide and troubleshooting section
2. Review logs in Vercel/Supabase dashboard
3. Check database `trader_anomalies` table for raw data
4. Open GitHub issue with details

## Changelog

### Version 1.0.0 (2026-01-28)

- Initial release
- Z-Score and IQR detection
- Multi-dimensional analysis
- Admin API
- Cron job integration
