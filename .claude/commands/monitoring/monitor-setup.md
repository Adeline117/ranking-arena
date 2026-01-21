# Monitoring and Observability Setup

Implement comprehensive monitoring solutions with metrics collection, distributed tracing, log aggregation, and actionable dashboards.

## Requirements

Setup monitoring for: **$ARGUMENTS**

## Three Pillars of Observability

### 1. Metrics (Prometheus)

```yaml
# prometheus.yml
global:
  scrape_interval: 15s

scrape_configs:
  - job_name: 'application'
    static_configs:
      - targets: ['app:8080']
```

**Key Metrics**:
- Request rate, error rate, duration (RED)
- Utilization, saturation, errors (USE)
- Business metrics (conversions, signups)

### 2. Logs (Structured Logging)

```typescript
const logger = {
  info: (message: string, context: object) => {
    console.log(JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'INFO',
      message,
      ...context
    }));
  }
};
```

**Best Practices**:
- Use structured JSON format
- Include correlation IDs
- Log at appropriate levels
- Avoid sensitive data

### 3. Traces (OpenTelemetry)

```typescript
import { NodeSDK } from '@opentelemetry/sdk-node';
import { JaegerExporter } from '@opentelemetry/exporter-jaeger';

const sdk = new NodeSDK({
  traceExporter: new JaegerExporter(),
  serviceName: 'my-service'
});
sdk.start();
```

## Grafana Dashboards

### Service Dashboard Panels
- Request Rate (by method)
- Error Rate (5xx/total)
- Latency Percentiles (p50, p95, p99)
- Resource Utilization (CPU, Memory)

## Alerting Configuration

```yaml
# alerts.yml
groups:
  - name: application
    rules:
      - alert: HighErrorRate
        expr: sum(rate(http_errors_total[5m])) / sum(rate(http_requests_total[5m])) > 0.05
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "High error rate detected"

      - alert: SlowResponseTime
        expr: histogram_quantile(0.95, rate(http_request_duration_seconds_bucket[5m])) > 1
        for: 10m
        labels:
          severity: warning
```

## SLO Implementation

### Define SLIs
- Availability: % of successful requests
- Latency: p99 response time
- Throughput: Requests per second

### Set SLOs
- 99.9% availability (8.76h downtime/year)
- p99 latency < 500ms
- 1000 RPS capacity

### Error Budget
- Monthly budget = 100% - SLO target
- Track burn rate
- Alert on fast burn

## Output

1. **Infrastructure Assessment**: Current monitoring gaps
2. **Monitoring Architecture**: Complete stack design
3. **Metric Definitions**: Comprehensive catalog
4. **Dashboard Templates**: Grafana JSON
5. **Alert Rules**: Prometheus alerting config
6. **SLO Definitions**: Service level objectives
