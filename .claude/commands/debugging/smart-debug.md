# Smart Debug - AI-Assisted Debugging Workflow

AI-assisted debugging using observability data, pattern recognition, and systematic root cause analysis.

## Target

Debug: **$ARGUMENTS**

## 10-Step Debugging Methodology

### 1. Initial Triage
- Use AI pattern recognition on error messages
- Classify error type and severity
- Identify affected components

### 2. Observability Data Collection
- Gather data from monitoring platforms (Sentry, DataDog, etc.)
- Collect relevant logs, traces, and metrics
- Establish timeline of events

### 3. Hypothesis Generation
- Generate probable root causes with confidence scores
- Prioritize hypotheses by likelihood and impact
- Consider recent changes and deployments

### 4. Evidence Gathering
- Collect supporting evidence for top hypotheses
- Review git history for recent changes
- Check configuration changes

### 5. Intelligent Instrumentation
- Add strategic logging/tracing if needed
- Place targeted breakpoints
- Capture relevant state

### 6. Root Cause Analysis
- Apply Five Whys technique
- Trace error propagation path
- Identify contributing factors

### 7. Fix Implementation
- Develop minimal fix for root cause
- Consider side effects
- Plan rollback strategy

### 8. Verification
- Test fix in isolation
- Verify in staging environment
- Check for regression

### 9. Production Deployment
- Deploy with monitoring
- Use feature flags if available
- Monitor for recurrence

### 10. Prevention
- Add regression tests
- Update monitoring/alerts
- Document in runbook

## Production-Safe Techniques

- Feature-flagged logging
- Canary deployments
- Shadow debugging
- Sampling-based tracing

## Structured Report

```markdown
## Issue Summary
[Brief description]

## Root Cause
[Detailed explanation with evidence]

## Fix Applied
[Code changes and rationale]

## Prevention
[Regression tests, monitoring updates]

## Runbook Update
[Steps for future occurrences]
```

## Tool Integration

- **APM**: DataDog, New Relic, Dynatrace
- **Error Tracking**: Sentry, Bugsnag
- **Tracing**: Jaeger, Zipkin, OpenTelemetry
- **Logging**: ELK, Loki, CloudWatch
