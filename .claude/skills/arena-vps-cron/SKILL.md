# Arena external-worker schedule review

This skill is for repository-side and approved read-only review of external worker
cadence. Historical IPs, filesystem layouts, LaunchAgents, and crontabs are not
source of truth and must not be copied into commands.

## Evidence hierarchy

1. Current worker code and registry in the repository
2. Versioned deployment/runbook configuration
3. An approved, timestamped read-only host inventory
4. Process/heartbeat evidence bound to an exact release

A stale note or old host path is not authorization to connect.

## Safe review

- Inspect worker/src/ingest-worker.ts and lib/ingest/adapters/register.ts.
- Inspect checked-in health/heartbeat verification scripts and their tests.
- Compare the expected owner/region set, release SHA, heartbeat time, and queue state.
- Report missing visibility as unknown, not healthy.
- Keep Vercel schedules separate from external worker schedules.

## Changes

Worker cadence or topology changes require a reviewed config/code change, bounded
concurrency and overlap protection, rollback steps, and exact release evidence.
Do not edit a remote crontab, copy files between host directories, restart a process,
SSH to a host, or deploy from this workflow without explicit authorization.

Never read or print env files, connection strings, tokens, private payloads, or
credential-bearing process arguments.

## Verification

Use repository tests and mocked/local fixtures first. Any host-level check must be
read-only, scoped to the approved machine, and recorded with timestamp and release
identity. A restart, manual job run, queue mutation, or scheduler cleanup is an
external-state change and a separate gate.
