# Incident Response - Multi-Agent SRE Workflow

Orchestrate incident response with modern SRE practices for rapid resolution and learning.

## Incident

Respond to: **$ARGUMENTS**

## Severity Levels

- **P0/SEV-1**: Complete outage, security breach, data loss - immediate all-hands
- **P1/SEV-2**: Major degradation, significant user impact - rapid response
- **P2/SEV-3**: Minor degradation, limited impact - standard response
- **P3/SEV-4**: Cosmetic issues, no user impact - scheduled resolution

## Phase 1: Detection & Triage

### Incident Classification
1. Determine severity (P0-P3)
2. Identify affected services and dependencies
3. Assess user impact and business risk
4. Establish incident command structure
5. Check SLO violations and error budgets

### Observability Analysis
- Query distributed tracing (OpenTelemetry/Jaeger)
- Check metrics correlation (Prometheus/Grafana/DataDog)
- Review log aggregation (ELK/Splunk)
- Analyze APM data
- Check Real User Monitoring

### Initial Mitigation
- Traffic throttling/rerouting if needed
- Feature flag disabling for affected features
- Circuit breaker activation
- Rollback assessment for recent deployments
- Scale resources if capacity-related

## Phase 2: Investigation & Root Cause

### Deep System Debugging
- Analyze stack traces and error logs
- Check database query performance
- Investigate network latency and timeouts
- Look for memory leaks and CPU spikes
- Map dependency failures

### Security Assessment
- Check for DDoS indicators
- Review authentication failures
- Assess data exposure risks
- Review WAF and audit logs

## Phase 3: Resolution & Recovery

### Fix Implementation
- Design minimal viable fix for rapid deployment
- Assess risks and plan rollback
- Create staged rollout plan with monitoring
- Define validation criteria

### Deployment
- Blue-green or canary deployment
- Progressive rollout with monitoring
- Health check validation at each stage
- Rollback triggers configured

## Phase 4: Communication

### Status Updates
- Public status page updates
- Internal engineering updates (technical)
- Executive summary (business impact/ETA)
- Customer support briefing

Update frequency based on severity:
- P0: Every 15 minutes
- P1: Every 30 minutes
- P2: Every hour

## Phase 5: Postmortem

### Blameless Postmortem
1. Complete incident timeline
2. Root cause and contributing factors
3. What went well in response
4. What could improve
5. Action items with owners and deadlines
6. Lessons learned

### Monitoring Enhancement
- New alerts for early detection
- SLI/SLO adjustments
- Dashboard improvements
- Runbook automation

## Success Criteria

### During Incident
- Service restoration within SLA
- Accurate severity classification in 5 minutes
- Regular stakeholder communication
- No cascading failures

### Post-Incident
- Postmortem within 48 hours
- All action items assigned
- Monitoring improvements deployed within 1 week
- Team training on lessons learned
