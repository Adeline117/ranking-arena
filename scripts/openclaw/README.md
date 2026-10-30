# OpenClaw integration — V1 NO-GO

OpenClaw automation is suspended for the V1 containment period. This directory
is not an installation guide and must not be used to add or restore a crontab,
OpenClaw schedule, automatic remediation, source fetching, commit, merge,
deploy, restart, backup, or external-ticket mutation.

## What remains permitted

Only task-authorized, non-remediating evidence collection in a controlled
environment is permitted. Start with the repository's canonical diagnostics:

```text
npm run diagnose
npm run check:status
npm run check:freshness
npm run check:platforms
npm run check:seasons
npm run check:enrichment
```

These diagnostics may report a problem; they never authorize an operational
change. Record the evidence and use the owner-approved incident or release
process for any next step.

## Retired compatibility paths

The following former autonomous controls are compatibility tombstones: they
write a `[RETIRED]` diagnostic to stderr and exit with status `2` without
loading credentials or contacting services.

- `auto-fix.mjs`, `schema-canary-sentinel.mjs`, and the five `fetch-*.mjs`
  source-fetch scripts
- `scripts/cron/auto-fix-platform.ts`, `merge-autofix-to-main.sh`, and
  `weekly-self-check.sh`
- `infra/vps-cron/deploy-vps-cron.sh`, `infra/vps-cron/vps-cron-htx.sh`, and
  its empty retired cron configuration
- `scripts/vps-deploy/{setup-crontab.sh,cron-runner.js,scraper-cron.mjs}`,
  `scripts/vps-scrapers/bybit-detail-pnl.mjs`, and `scripts/sync-vps-key.sh`
- `health-monitor.mjs --with-auto-fix`
- `pipeline-health-monitor.mjs --auto-cleanup`
- `sentry-convergence.mjs --resolve-stale`
- `field-coverage-canary.mts --update-baseline`

Baseline changes, deployments, production diagnostics that require credentials,
and all host-side cron or PM2 cleanup require explicit owner authorization.
This repository change cannot disable a schedule or process that was already
installed on a host; inventory and cleanup of those hosts is a separate,
authorized operation.
