# Performance Monitoring Dashboard

This document consolidates the design, user guide, and implementation details for the Ranking Arena Monitoring Dashboard.

**Version**: 1.0
**Status**: Production Ready
**Last Updated**: 2026-01-28

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Dashboard Components](#dashboard-components)
4. [Health Score Algorithm](#health-score-algorithm)
5. [Alert System](#alert-system)
6. [API Reference](#api-reference)
7. [Usage Guide](#usage-guide)
8. [Troubleshooting](#troubleshooting)
9. [Performance](#performance)
10. [Future Enhancements](#future-enhancements)

---

## Overview

The Performance Monitoring Dashboard provides real-time visibility into Ranking Arena's critical systems including Smart Scheduler, Anomaly Detection, data freshness, and overall platform health.

### Key Features

- **Real-time Health Scoring** (0-100)
- **Automated Alert Generation** (critical/warning)
- **Smart Scheduler Performance Tracking**
- **Anomaly Detection Monitoring**
- **API Cost Analysis**
- **Data Freshness Monitoring**
- **Auto-refresh** (configurable, default 30s)

### Access

```
URL: https://your-domain.com/admin/monitoring
Auth: Requires admin access via Supabase session
```

---

## Architecture

```
+-----------------------------------------------------+
|           Performance Monitoring Dashboard           |
+-----------------------------------------------------+
                        |
        +---------------+---------------+
        |               |               |
        v               v               v
+---------------+ +---------------+ +---------------+
|   General     | |   Scheduler   | |   Anomaly     |
|   Stats API   | |   Stats API   | |   Stats API   |
+---------------+ +---------------+ +---------------+
        |               |               |
        +---------------+---------------+
                        |
                        v
           +-------------------------+
           |  Monitoring Overview    |
           |  API (Aggregates All)   |
           +-------------------------+
                        |
        +-------+-------+-------+-------+
        |       |       |       |       |
        v       v       v       v       v
   Health   Alerts  Scheduler  Anomaly  System
   Score    Panel   Metrics    Metrics  Metrics
```

### Data Flow

1. User opens `/admin/monitoring`
2. Auto-refresh timer starts (30s)
3. Overview API fetches data from 3 internal APIs in parallel
4. Calculates health score and generates alerts
5. Components render with real-time metrics

---

## Dashboard Components

### 1. Health Score Card

Displays overall system health (0-100) with circular progress indicator.

| Score Range | Status | Color |
|-------------|--------|-------|
| 80-100 | Healthy | Green (#7CFFB2) |
| 60-79 | Warning | Yellow (#FFD700) |
| 0-59 | Critical | Red (#FF7C7C) |

Shows score breakdown by factor: data freshness, overdue traders, pending anomalies, scraper health.

### 2. Alerts Panel

Displays active system alerts with summary counts and scrollable list.

- **Critical** (Red): Immediate action required
- **Warning** (Yellow): Review within 24h
- **Info** (Green): Informational

### 3. Scheduler Metrics

Smart Scheduler performance tracking:
- **Tier Distribution**: Hot (15min) / Active (60min) / Normal (4h) / Dormant (24h)
- **API Efficiency**: Current vs smart scheduler calls/day, reduction percentage
- **Cost Savings**: Per day, month, year
- **Data Freshness**: Overdue count, last tier update

Shows "disabled" message if `ENABLE_SMART_SCHEDULER=false`.

### 4. Anomaly Metrics

Anomaly detection status:
- **Detection Overview**: Total, pending, investigating, resolved
- **Severity Breakdown**: Critical, high, medium, low
- **Detection Methods**: Z-Score, IQR, pattern counts
- **Recent Detections**: Last 5 anomalies with trader ID, platform, type

Shows "disabled" message if `ENABLE_ANOMALY_DETECTION=false`.

### 5. System Metrics

General platform health:
- **User Activity**: Total users, new today, banned
- **Content Activity**: Posts, comments, new today
- **Moderation Queue**: Pending reports, group applications
- **Scraper Health**: Fresh (<12h), stale (12-24h), critical (>24h)

---

## Health Score Algorithm

Base score starts at 100 with deductions:

### Scraper Health (max -30 points)

```
deduction = min(30, stalePercent * 0.2 + criticalPercent * 0.5)
```

### Overdue Traders (max -30 points)

```
deduction = min(30, overduePercent * 0.3)
```

### Pending Anomalies (max -20 points)

```
deduction = min(20, pendingAnomalies * 0.5)
```

### Reserved (max -20 points)

Future: API response times, error rates, uptime.

---

## Alert System

### Alert Generation Rules

**Critical Alerts**:
- Critical anomalies detected (`criticalCount > 0`)
- Scrapers not updating >24h (`critical > 0`)

**Warning Alerts**:
- High overdue trader count (`overdueTraders > 10%`)
- Multiple high-severity anomalies (`highCount > 10`)

### Alert Lifecycle

1. Generated based on current metrics
2. Displayed in AlertsPanel
3. Auto-resolved when metrics improve

---

## API Reference

### Primary Endpoint

```http
GET /api/admin/monitoring/overview
Authorization: Bearer <access_token>
```

Returns:
- `health`: score, status, color, message
- `alerts`: total, critical, warning, items
- `scheduler`: enabled, tierDistribution, apiEfficiency, dataFreshness
- `anomalyDetection`: enabled, stats, recentAnomalies
- `system`: users, content, moderation, scraperHealth

Rate limited: 15 req/min.

### Individual Data Sources

```
GET /api/admin/stats                  # General system stats
GET /api/admin/scheduler/stats        # Smart Scheduler metrics
GET /api/admin/anomalies/stats        # Anomaly Detection stats
```

---

## Usage Guide

### Daily Monitoring (5 minutes)

1. Check Health Score (target >85)
2. Review Active Alerts (address critical items)
3. Verify Scraper Health (all should be "Fresh")
4. Check Anomaly Detection (review new critical anomalies)

### Weekly Review (15 minutes)

1. Analyze Smart Scheduler performance (API reduction >60%)
2. Review anomaly detection trends (false positive rate decreasing?)
3. Check system growth metrics (user growth, content creation)

### Monthly Analysis (30 minutes)

1. Export and analyze cost savings data
2. Review scheduler efficiency trends
3. Adjust tier thresholds if needed
4. Plan optimizations based on metrics

### Auto-Refresh

- Toggle checkbox in header (default: enabled)
- Interval: 30 seconds
- Disable during detailed investigation or to reduce API load

---

## Troubleshooting

### Dashboard Not Loading
1. Refresh session (check authentication)
2. Verify admin permissions in Supabase
3. Check browser console for errors
4. Clear browser cache and reload

### Data Not Updating
1. Check auto-refresh enabled
2. Manually click "Refresh Now"
3. Verify API endpoints responding
4. Check Vercel deployment status

### Missing Sections
- Smart Scheduler: Set `ENABLE_SMART_SCHEDULER=true`
- Anomaly Detection: Set `ENABLE_ANOMALY_DETECTION=true`

### Slow Performance
1. Disable auto-refresh temporarily
2. Check database connection pool
3. Review API endpoint performance
4. Consider caching layer (Redis)

---

## Performance

| Metric | Target | Status |
|--------|--------|--------|
| Page Load Time | <2s | Met |
| API Response | <500ms | Met |
| Auto-refresh Overhead | <100ms | Met |
| Mobile Lighthouse | >90 | Pending |

### Optimizations

- Parallel data fetching (3x faster than sequential)
- SWR for client-side caching
- Auto-refresh only when page visible
- Graceful degradation for individual section failures

---

## Future Enhancements

### Phase 2 (Q2 2026)
- Historical 30-day trend charts
- Custom alert thresholds
- Webhook/email/Slack notifications
- CSV/PDF export

### Phase 3 (Q3 2026)
- Predictive analytics and capacity planning
- Mobile app (iOS/Android) with push notifications
- Team collaboration (alert assignments, incident tracking)

---

## File Structure

```
app/admin/monitoring/
  page.tsx                           # Main page component
  components/
    HealthScoreCard.tsx              # Health score display
    AlertsPanel.tsx                  # Alerts display
    SchedulerMetrics.tsx             # Scheduler metrics
    AnomalyMetrics.tsx               # Anomaly metrics
    SystemMetrics.tsx                # System metrics

app/api/admin/monitoring/
  overview/route.ts                  # Aggregation API
```

---

## Performance Targets

### Health Score
- Target: >85
- Warning: 70-85
- Critical: <70

### Smart Scheduler
- API Reduction: >60%
- Cost Savings: >$25,000/month
- Overdue Traders: <5%

### Anomaly Detection
- False Positive Rate: <20%
- Detection Latency: <6 hours
- Resolution Time: <48 hours (critical)

### Data Freshness
- Fresh Scrapers: >80%
- Stale Scrapers: <15%
- Critical Scrapers: <5%

---

## Alert Response Guide

| Alert | Response |
|-------|----------|
| Critical Anomalies | Review at `/api/admin/anomalies`, investigate, mark as investigating, resolve |
| Scraper Health Critical | Check Vercel cron logs, verify endpoints, review rate limits, manually trigger |
| High Overdue Count | Verify scheduler enabled, check tier calculation, adjust batch sizes |
| Multiple High Anomalies | Review patterns, check platform-specific issues, adjust thresholds |

---

> Consolidated from: MONITORING_DASHBOARD_DESIGN.md, MONITORING_DASHBOARD_GUIDE.md, MONITORING_DASHBOARD_SUMMARY.md
