# Performance Monitoring Dashboard - User Guide

**Version**: 1.0
**Last Updated**: 2026-01-28
**Status**: Production Ready

---

## Overview

The Performance Monitoring Dashboard provides real-time visibility into Ranking Arena's system health, Smart Scheduler performance, Anomaly Detection status, and overall platform metrics.

### Key Features

- **Real-time Health Scoring** (0-100)
- **Automated Alert Generation**
- **Smart Scheduler Performance Tracking**
- **Anomaly Detection Monitoring**
- **API Cost Analysis**
- **Data Freshness Monitoring**
- **Auto-refresh** (configurable, default 30s)

---

## Access

### URL
```
https://your-domain.com/admin/monitoring
```

### Authentication
- Requires admin access
- Automatic redirect to login if not authenticated
- Session-based authentication via Supabase

---

## Dashboard Components

### 1. System Health Score

**Location**: Top-left card

**What it shows**:
- Overall system health score (0-100)
- Visual circular progress indicator
- Status badge (Healthy/Warning/Critical)
- Score breakdown factors

**Score Calculation**:
- **100-80**: Healthy (Green)
- **79-60**: Warning (Yellow)
- **59-0**: Critical (Red)

**Factors**:
- Data Freshness (-30 points max)
- Overdue Traders (-30 points max)
- Pending Anomalies (-20 points max)
- Scraper Health (-20 points max)

**Example**:
```
Score: 87
Status: Healthy ✓
Message: System operating normally

Factors:
- Data Freshness: ✓
- Anomaly Status: ✓
- Scraper Health: ✓
```

---

### 2. Active Alerts Panel

**Location**: Top-right card

**What it shows**:
- Total alert count
- Critical alerts (red)
- Warning alerts (yellow)
- Individual alert details

**Alert Types**:

#### Critical Alerts
- Critical anomalies detected
- Scrapers not updating >24h
- System failures

#### Warning Alerts
- High overdue trader count (>10%)
- Multiple high-severity anomalies
- Stale data (12-24h)

**Example Alert**:
```
🔴 Critical Anomalies Detected
5 critical anomalies require immediate attention
10:45 AM
```

---

### 3. Smart Scheduler Metrics

**Location**: Third section

**What it shows**:

#### Tier Distribution
- Hot tier (15 min refresh)
- Active tier (60 min refresh)
- Normal tier (4h refresh)
- Dormant tier (24h refresh)

**Example**:
```
Hot:     150 traders (1.25%) • 15 minutes
Active:  800 traders (6.67%) • 60 minutes
Normal:  3,000 traders (25%) • 240 minutes
Dormant: 8,050 traders (67%) • 1440 minutes
```

#### API Call Efficiency
- Current system calls/day
- Smart scheduler calls/day
- Reduction percentage
- Calls saved per day

**Example**:
```
Current System:  72,000 calls/day
Smart Scheduler: 59,650 calls/day
Reduction:       17.2% (12,350 calls saved)
```

#### Cost Savings
- Per day
- Per month
- Per year

**Example**:
```
Per Day:   $923
Per Month: $27,690
Per Year:  $332,280
```

#### Data Freshness
- Overdue traders count
- Last tier update timestamp

---

### 4. Anomaly Detection Metrics

**Location**: Fourth section

**What it shows**:

#### Detection Overview
- Total anomalies
- Pending review
- Under investigation
- Resolved

#### By Severity
- Critical (immediate action)
- High (review within 24h)
- Medium (review within week)
- Low (informational)

#### Detection Methods
- Z-Score (statistical outliers)
- IQR (robust detection)
- Pattern (behavioral anomalies)

#### Recent Detections
- Last 5 anomalies
- Trader ID, platform
- Detection type
- Timestamp

**Example Recent Detection**:
```
CRITICAL
trader_123 • binance
z_score detection on roi
10:42 AM
```

---

### 5. System Metrics

**Location**: Bottom section

**What it shows**:

#### User Activity
- Total users
- New today (vs yesterday)
- New yesterday
- Banned users

#### Content Activity
- Total posts
- New posts today (vs yesterday)
- Total comments
- New comments today

#### Moderation Queue
- Pending reports
- Reports this week
- Total groups
- Pending applications

#### Data Scraper Status
- Fresh (<12h)
- Stale (12-24h)
- Critical (>24h)

---

## How to Use

### Daily Monitoring Routine

**Morning Check (5 minutes)**:
1. Check Health Score - should be >80
2. Review Active Alerts - address critical items
3. Verify Scraper Health - all should be "Fresh"
4. Check Anomaly Detection - review new critical anomalies

**Weekly Review (15 minutes)**:
1. Analyze Smart Scheduler performance
   - Verify API reduction meeting targets (>60%)
   - Check cost savings tracking correctly
   - Review tier distribution changes
2. Anomaly Detection trends
   - Are false positives decreasing?
   - Which detection methods most effective?
3. System growth metrics
   - User growth rate
   - Content creation trends

**Monthly Analysis (30 minutes)**:
1. Export and analyze cost savings data
2. Review scheduler efficiency trends
3. Adjust tier thresholds if needed
4. Plan optimizations based on metrics

---

### Auto-Refresh

**Enable/Disable**:
- Toggle checkbox in header
- Default: Enabled
- Refresh interval: 30 seconds

**When to Disable**:
- During detailed investigation
- When reviewing historical data
- To reduce API load during incidents

**When to Keep Enabled**:
- Normal monitoring
- During deployments
- Incident response

---

## Alert Response Guide

### Critical Alerts

#### "Critical Anomalies Detected"
**Response**:
1. Navigate to `/api/admin/anomalies`
2. Review anomaly details
3. Investigate trader data source
4. Mark as "investigating"
5. Fix root cause
6. Mark as "resolved" or "false_positive"

#### "Scraper Health Critical"
**Response**:
1. Check Vercel cron job logs
2. Verify scraper endpoints accessible
3. Review rate limiting issues
4. Manually trigger scraper if needed
5. Monitor for recovery

### Warning Alerts

#### "High Overdue Trader Count"
**Response**:
1. Check Smart Scheduler enabled
2. Verify tier calculation running
3. Review overdue traders by tier
4. Adjust batch sizes if needed
5. Monitor for improvement

#### "Multiple High-Severity Anomalies"
**Response**:
1. Review patterns in anomalies
2. Check if related to specific platform
3. Adjust detection thresholds if needed
4. Batch review and resolve

---

## Performance Targets

### Health Score
- **Target**: >85
- **Warning**: 70-85
- **Critical**: <70

### Smart Scheduler
- **API Reduction**: >60%
- **Cost Savings**: >$25,000/month
- **Overdue Traders**: <5%

### Anomaly Detection
- **False Positive Rate**: <20%
- **Detection Latency**: <6 hours
- **Resolution Time**: <48 hours (critical)

### Data Freshness
- **Fresh Scrapers**: >80%
- **Stale Scrapers**: <15%
- **Critical Scrapers**: <5%

---

## Troubleshooting

### Dashboard Not Loading

**Symptoms**: Blank page or loading indefinitely

**Solutions**:
1. Check authentication - refresh session
2. Verify admin permissions in Supabase
3. Check browser console for errors
4. Clear browser cache and reload

### Data Not Updating

**Symptoms**: Timestamp not changing, stale data

**Solutions**:
1. Check auto-refresh enabled
2. Manually click "Refresh Now"
3. Verify API endpoints responding:
   - `/api/admin/stats`
   - `/api/admin/scheduler/stats`
   - `/api/admin/anomalies/stats`
4. Check Vercel deployment status

### Missing Metrics

**Symptoms**: Sections showing "disabled" or "error"

**Solutions**:

#### Smart Scheduler Missing
```bash
# Set in Vercel environment variables
ENABLE_SMART_SCHEDULER=true
```

#### Anomaly Detection Missing
```bash
# Set in Vercel environment variables
ENABLE_ANOMALY_DETECTION=true
```

### Slow Performance

**Symptoms**: Dashboard takes >5s to load

**Solutions**:
1. Disable auto-refresh temporarily
2. Check database connection pool
3. Review API endpoint performance
4. Consider caching layer (Redis)

---

## API Endpoints

The dashboard aggregates data from these endpoints:

### Primary
```
GET /api/admin/monitoring/overview
```
Returns comprehensive monitoring data including:
- Health score
- Alerts
- Scheduler metrics
- Anomaly metrics
- System metrics

### Individual Endpoints
```
GET /api/admin/stats                  # General system stats
GET /api/admin/scheduler/stats        # Smart Scheduler metrics
GET /api/admin/anomalies/stats        # Anomaly Detection stats
```

### Authentication
All endpoints require:
```
Authorization: Bearer <access_token>
```

---

## Best Practices

### 1. Regular Monitoring
- Check dashboard at least daily
- Set up alerts for critical metrics
- Review weekly trends

### 2. Alert Management
- Address critical alerts within 1 hour
- Review warnings daily
- Document false positives

### 3. Performance Optimization
- Use auto-refresh during normal operations
- Disable during investigations
- Export data for long-term analysis

### 4. Incident Response
- Health score <60: Immediate investigation
- Multiple critical alerts: Escalate
- Sustained warnings: Plan optimization

### 5. Data-Driven Decisions
- Use metrics to justify optimizations
- Track improvements over time
- Share insights with team

---

## Advanced Features

### Custom Alerts (Future)
- Webhook notifications
- Email alerts
- Slack integration
- PagerDuty integration

### Historical Data (Future)
- 30-day trend charts
- Performance comparisons
- Anomaly patterns

### Export Functionality (Future)
- CSV export
- PDF reports
- Scheduled reports

---

## FAQ

### Q: How often should I check the dashboard?
**A**: Daily for health checks, weekly for trends, monthly for analysis.

### Q: What's a good health score?
**A**: Above 85 is excellent, 70-85 is acceptable, below 70 requires attention.

### Q: Can I customize alert thresholds?
**A**: Currently fixed, but customization is planned for future release.

### Q: How do I export metrics?
**A**: Use browser DevTools Network tab to capture API responses, export planned for future.

### Q: Dashboard shows old data?
**A**: Click "Refresh Now" or check auto-refresh enabled. Verify API endpoints responding.

### Q: Can I share dashboard with non-admins?
**A**: No, requires admin authentication for security. Consider creating read-only dashboards in future.

---

## Support

### Issues
Report issues at: https://github.com/your-org/ranking-arena/issues

### Documentation
- **Design**: `docs/MONITORING_DASHBOARD_DESIGN.md`
- **API Reference**: `docs/API_REFERENCE.md`
- **Smart Scheduler**: `SMART_SCHEDULER_INTEGRATION.md`
- **Anomaly Detection**: `docs/ANOMALY_DETECTION_GUIDE.md`

### Contact
For urgent issues, contact the development team.

---

**Last Updated**: 2026-01-28
**Version**: 1.0
**Status**: Production Ready
